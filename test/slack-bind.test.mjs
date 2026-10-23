import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { slashCommand, HELP } from '../src/slack-bind-commands.mjs';
import { commandServer } from '../src/slack-command-server.mjs';
import { SlackClient } from '../src/slack-client.mjs';
import { SlackBinding, stableId } from '../src/slack-bind.mjs';
import { BindStore } from '../src/slack-bind-store.mjs';
import { BindLinear } from '../src/bind-linear.mjs';
import { bindConfig } from '../src/slack-bind-config.mjs';

// All IDs, names, tokens, and Meet links below are fictitious fixtures.
const meet = 'https://meet.google.com/abc-defg-hij';
const mode = 'slash-only-v1';
function fixture(options = {}) {
  const state = { version: 1, teamId: 'TTEST', botId: 'UBOT', startedAt: 1700000000, inbox: {}, threads: {}, processed: {}, outbox: {}, channels: {}, search: {} };
  const store = { state, save: async () => {} };
  const calls = [];
  const api = {
    jobs: [], transcripts: [],
    meetings: async () => { calls.push('meetings'); return { meetings: api.jobs }; },
    transcriptsList: async () => { calls.push('transcripts'); return { transcripts: api.transcripts }; },
    join: async (url, args) => { calls.push({ action: 'join', url, args }); return { status: 'queued' }; },
    stop: async (url, args) => { calls.push({ action: 'stop', url, args }); return { status: 'stop_queued' }; },
  };
  // Any Slack history/search/post/upload or Linear operation is a regression.
  const forbidden = new Proxy({}, { get: (_, key) => { throw new Error(`Unexpected external operation: ${String(key)}`); } });
  const config = { allowedUsers: [], channelIds: [], meetingAccess: 'workspace' };
  const binding = new SlackBinding({ config, store, api, bot: forbidden, user: forbidden, linear: forbidden,
    identity: { bot: { user_id: 'UBOT' }, user: { user_id: 'UOWNER' } }, log: () => {}, ...options });
  const input = { channel: 'CTEST', user: 'UOWNER', text: meet, trigger: 'example-trigger', slash: '/meeting' };
  return { binding, state, store, api, calls, config, input };
}

test('only explicit slash arguments are supported; links are normalized and ordinary chat is rejected', () => {
  assert.deepEqual(slashCommand(`${meet}?pli=1`), { action: 'join', url: meet });
  assert.deepEqual(slashCommand(`join <${meet}?pli=1|meeting>`), { action: 'join', url: meet });
  for (const text of ['', 'help']) assert.equal(slashCommand(text).action, 'help');
  assert.equal(slashCommand('status').action, 'status');
  assert.equal(slashCommand('stop').action, 'stop');
  for (const text of [`@Yumi 幫我錄影 ${meet}`, `meeting-mate join ${meet}`, `不要錄影 ${meet}`, `join ${meet} ${meet}`, 'approve', 'minutes {}', 'follow TEST-1', 'retry', 'stop --thread 1700000000.000001', 'https://evil.example/', 'x'.repeat(8001)]) {
    assert.equal(slashCommand(text).action, 'invalid', text.slice(0, 80));
  }
});

test('ordinary messages and unsupported slash commands cannot enqueue work', async () => {
  const f = fixture();
  for (const slash of [undefined, '/other', 'meeting-mate']) await f.binding.acceptSlash({ ...f.input, slash });
  await f.binding.cycle();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.state.inbox, {});
});

test('slash receipt persists before ACK, and retries execute one join without posting a thread', async () => {
  const f = fixture();
  assert.match(await f.binding.acceptSlash(f.input), /不代表已開始錄影/);
  await f.binding.acceptSlash(f.input);
  assert.deepEqual(f.calls, []); assert.equal(Object.keys(f.state.inbox).length, 1);
  await Promise.all([f.binding.cycle(), f.binding.cycle()]);
  await f.binding.acceptSlash(f.input); await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 1);
  assert(f.calls.find(c => c.action === 'join').args.idempotencyKey);
  assert.deepEqual(f.state.threads, {}); assert.deepEqual(f.state.outbox, {});
  assert.equal(Object.values(f.state.inbox)[0].state, 'done');
});

test('uncommitted receipts cannot be acknowledged or executed; failed writes are rejected', async () => {
  const f = fixture(); let resolve, reject, acked = false;
  f.store.save = () => new Promise((yes, no) => { resolve = yes; reject = no; });
  const pending = f.binding.acceptSlash(f.input).then(() => { acked = true; });
  const duplicate = f.binding.acceptSlash(f.input);
  await f.binding.cycle(); assert.deepEqual(f.calls, []); assert.equal(acked, false);
  resolve(); await Promise.all([pending, duplicate]); assert.equal(acked, true);
  const failure = f.binding.acceptSlash({ ...f.input, trigger: 'failed-write' });
  reject(new Error('Fixture disk full')); await assert.rejects(failure);
  assert.equal(Object.keys(f.state.inbox).length, 1);
  f.store.save = async () => {}; await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 1);
});

test('workspace members can join, query and stop; optional owner and channel restrictions still work', async () => {
  const f = fixture();
  await f.binding.acceptSlash({ ...f.input, user: 'UTEAMMATE' }); await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 1);
  await f.binding.acceptSlash({ ...f.input, user: 'UANOTHER', text: '', slash: '/meeting-stop', trigger: 'stop' });
  await f.binding.cycle(); assert.equal(f.calls.filter(c => c.action === 'stop').length, 1);
  assert.match(await f.binding.acceptSlash({ ...f.input, user: 'UANOTHER', text: 'status' }), /目前/);
  f.config.meetingAccess = 'owner';
  assert.match(await f.binding.acceptSlash({ ...f.input, user: 'UOTHER', trigger: 'restricted' }), /尚未授權/);
  f.config.allowedUsers = ['UALLOWED'];
  await f.binding.acceptSlash({ ...f.input, user: 'UALLOWED', trigger: 'allowed' });
  f.config.channelIds = ['COTHER'];
  assert.match(await f.binding.acceptSlash({ ...f.input, trigger: 'wrong-channel' }), /未啟用/);
  assert.equal(Object.keys(f.state.inbox).length, 3);
});

test('stop takes priority over a full join queue and never depends on Slack message delivery', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.state.inbox[`pending-${i}`] = { id: `pending-${i}`, mode, action: 'join', cmd: { action: 'join', url: meet }, state: 'queued' };
  assert.match(await f.binding.acceptSlash(f.input), /佇列已滿/);
  const stop = { ...f.input, slash: '/meeting-stop', text: '', trigger: 'stop-full-queue', user: 'UTEAMMATE' };
  assert.match(await f.binding.acceptSlash(stop), /已受理停止/);
  await f.binding.cycle(); await f.binding.acceptSlash(stop); await f.binding.cycle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'stop'); assert.equal(f.calls[0].url, undefined);
  assert(f.calls[0].args.idempotencyKey);
  assert(Object.values(f.state.inbox).filter(i => i.action === 'join').every(i => i.state === 'failed'));
});

test('/meeting stop is also a stop trigger, while a busy recorder rejects a new join', async () => {
  const f = fixture();
  f.api.jobs = [{ state: 'recording', joinedAt: 1700000000 }];
  await f.binding.acceptSlash(f.input); await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 0);
  assert.match(Object.values(f.state.inbox)[0].result, /已有會議/);
  await f.binding.acceptSlash({ ...f.input, text: 'stop', trigger: 'stop-alias' }); await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'stop').length, 1);
});

test('stop also cancels a join whose receipt is still being persisted', async () => {
  const f = fixture(); let finishJoinWrite;
  f.store.save = () => new Promise(resolve => { finishJoinWrite = resolve; });
  const joining = f.binding.acceptSlash(f.input);
  f.store.save = async () => {};
  await f.binding.acceptSlash({ ...f.input, slash: '/meeting-stop', trigger: 'cancel-uncommitted' });
  await f.binding.cycle();
  finishJoinWrite(); await joining; await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 0);
  assert.equal(f.calls.filter(c => c.action === 'stop').length, 1);
});

test('old threads, queued replies, transcript handoffs and Linear work stay inert across restart', async () => {
  const f = fixture();
  f.state.threads = { transcript: { stage: 'transcribing', transcriptId: 'fixture' }, linear: { stage: 'creating_issues', issues: [{}] }, reminder: { stage: 'following', issues: [{}] } };
  f.state.outbox = { bot: { state: 'queued', text: 'Private fixture' }, user: { state: 'queued', asUser: true, text: 'Private handoff fixture' } };
  f.state.inbox.legacy = { id: 'legacy', state: 'queued', cmd: { action: 'join', url: meet } };
  const oldOutbox = structuredClone(f.state.outbox), oldThreads = structuredClone(f.state.threads);
  await f.binding.prepare(); await f.binding.cycle(); await f.binding.prepare(); await f.binding.cycle();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state.outbox, oldOutbox); assert.deepEqual(f.state.threads, oldThreads);
  assert.equal(f.state.inbox.legacy.state, 'failed');
});

test('new durable commands resume after restart, but interrupted operations are never blindly replayed', async () => {
  const f = fixture();
  await f.binding.acceptSlash(f.input);
  f.state.inbox.interrupted = { id: 'interrupted', mode, action: 'stop', state: 'executing', cmd: { action: 'stop' } };
  await f.binding.prepare(); await f.binding.cycle();
  assert.equal(f.calls.filter(c => c.action === 'join').length, 1);
  assert.equal(f.calls.filter(c => c.action === 'stop').length, 0);
  assert.match(f.state.inbox.interrupted.result, /尚未確認/);
});

test('status is requested explicitly, shows phase progress, and never shares transcript text or private paths', async () => {
  const f = fixture();
  f.api.jobs = [{ state: 'recording', joinedAt: 1700000000, url: meet, recordingFile: '/private/fixture.mp4' }];
  f.api.transcripts = [{ id: 'fixture-job', state: 'running', phase: 'diarizing', progress: 100, result: { text: 'private transcript fixture' } }];
  await f.binding.cycle(); assert.deepEqual(f.calls, []);
  const reply = await f.binding.acceptSlash({ ...f.input, text: 'status' });
  assert.match(reply, /recording/); assert.match(reply, /diarizing 100\.0%/); assert.match(reply, /不代表整份/);
  assert(!reply.includes(meet)); assert(!reply.includes('/private/')); assert(!reply.includes('private transcript'));
  assert.deepEqual(f.state.inbox, {}); assert.deepEqual(f.state.outbox, {});
});

test('status has a bounded HTTP response even when local calls stall', async () => {
  const f = fixture({ statusTimeoutMs: 20 }); let signal;
  f.api.meetings = async options => { signal = options.signal; return new Promise(() => {}); };
  f.api.transcriptsList = async () => new Promise(() => {});
  const reply = await f.binding.acceptSlash({ ...f.input, text: 'status' });
  assert.match(reply, /逾時/); assert(signal.aborted); assert.deepEqual(f.state.inbox, {});
});

test('local failures remain available on explicit status without automatic retries or private error details', async () => {
  const f = fixture();
  f.api.join = async () => { f.calls.push({ action: 'join' }); throw Object.assign(new Error('PRIVATE ERROR BODY'), { code: 'service_unavailable' }); };
  await f.binding.acceptSlash(f.input); await f.binding.cycle(); await f.binding.cycle();
  const reply = await f.binding.acceptSlash({ ...f.input, text: 'status' });
  assert.match(reply, /service_unavailable/); assert(!reply.includes('PRIVATE ERROR BODY'));
  assert.equal(f.calls.filter(c => c.action === 'join').length, 1);
});

test('quiet configuration needs no user search or Linear credentials and ignores legacy workflow settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-bind-config-'));
  await writeFile(path.join(directory, '.env.yumi'), 'BOT_USER_OAUTH_TOKEN=fake-bot\nSLACK_BIND_PORT=0\nSLACK_BIND_LINEAR_ENV=/nonexistent/private.env\nSLACK_BIND_HANDOFF=true\n');
  const config = await bindConfig(directory, {});
  assert.equal(config.port, 0); assert.equal(config.meetingAccess, 'workspace');
  assert.equal(config.userToken, undefined); assert.equal(config.handoff, undefined); assert.equal(config.linearToken, undefined);
  await assert.rejects(bindConfig(directory, { SLACK_BIND_MEETING_ACCESS: 'owner' }), /Owner access/);
  assert.equal((await bindConfig(directory, { SLACK_BIND_MEETING_ACCESS: 'owner', SLACK_BIND_ALLOWED_USER_IDS: 'UOWNER' })).meetingAccess, 'owner');
  await assert.rejects(bindConfig(directory, { SLACK_BIND_MEETING_ACCESS: 'invalid' }), /MEETING_ACCESS/);
  await assert.rejects(bindConfig(directory, { SLACK_BIND_PORT: '18007' }), /SIGNING_SECRET/);
});

test('signed HTTP requests persist before ack; reject tampering, replay age, cross-app and oversized input', async t => {
  const now = 1700000000000, secret = 'fictitious-signing-secret'; let accepted = [];
  const server = commandServer({ signingSecret: secret, teamId: 'TTEST', appId: 'ATEST', now: () => now, log: () => {}, accept: async payload => { accepted.push(payload); return 'queued'; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const form = { api_app_id: 'ATEST', team_id: 'TTEST', channel_id: 'CTEST', user_id: 'UOWNER', command: '/meeting', text: `${meet}?pli=1`, trigger_id: 'fake-trigger', token: 'fixture-only', response_url: 'https://hooks.slack.com/commands/fake' };
  const request = async ({ fields = {}, timestamp = '1700000000', signature, body, endpoint = '/meeting' } = {}) => {
    body ??= new URLSearchParams({ ...form, ...fields }).toString();
    signature ??= `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    return fetch(url + endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature }, body });
  };
  const result = await request(); assert.equal(result.status, 200); assert.equal((await result.json()).response_type, 'ephemeral');
  assert.deepEqual(Object.keys(accepted[0]).sort(), ['channel', 'slash', 'text', 'trigger', 'user']);
  assert.equal((await request({ signature: `v0=${'0'.repeat(64)}` })).status, 401);
  assert.equal((await request({ timestamp: '1699999600' })).status, 401);
  assert.equal((await request({ timestamp: '1700000400' })).status, 401);
  assert.equal((await request({ fields: { team_id: 'TOTHER' } })).status, 403);
  assert.equal((await request({ fields: { api_app_id: 'AOTHER' } })).status, 403);
  assert.equal((await request({ fields: { text: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await request({ endpoint: '/v1/meetings/join' })).status, 404);
  assert.equal((await request({ endpoint: '/slack/events' })).status, 404);
  assert.equal((await fetch(url + '/meeting', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'event_callback', event: { text: `meeting-mate join ${meet}` } }) })).status, 415);
  assert.equal(accepted.length, 1);
  assert.equal((await request({ fields: { command: '/meeting-stop', text: '' }, endpoint: '/meeting-stop' })).status, 200);
  assert.equal(accepted[1].slash, '/meeting-stop');
  assert.equal((await request({ fields: { command: '/meeting-stop', text: '' } })).status, 200);
  assert.equal((await request({ endpoint: '/meeting-stop' })).status, 403);
});

test('private state is atomic under concurrent writes and enforces workspace identity and singleton', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-bind-'));
  const store = new BindStore(directory); await store.acquire(); t.after(() => store.release());
  await store.load('TTEST', 'UBOT');
  const writes = [];
  for (let i = 0; i < 20; i++) { store.state.counter = i; writes.push(store.save()); }
  await Promise.all(writes);
  assert.equal(JSON.parse(await readFile(store.filename)).counter, 19);
  assert.equal((await stat(store.filename)).mode & 0o777, 0o600);
  await assert.rejects(new BindStore(directory).acquire(), /Another/);
  await assert.rejects(new BindStore(directory).load('TOTHER', 'UBOT'), /preserved/);
});

test('Slack pagination uses GET query parameters, upload POST, fixed origins and Retry-After', async () => {
  let calls = [], page = 0, now = 1000;
  const client = new SlackClient('fixture-token', { now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.pathname.endsWith('/conversations.history')) return Response.json({ ok: true, messages: [{ ts: `${++page}.000001` }], has_more: page === 1, response_metadata: { next_cursor: page === 1 ? 'page2' : '' } });
    if (url.pathname.endsWith('/files.getUploadURLExternal')) {
      assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get('filename'), 'test.json'); assert.equal(fields.get('length'), '1');
      return Response.json({ ok: true, file_id: 'FTEST' });
    }
    return new Response('', { status: 429, headers: { 'retry-after': '30' } });
  } });
  assert.equal((await client.messages('CTEST', { oldest: '1' })).length, 2);
  assert.equal(calls[0].url.searchParams.get('channel'), 'CTEST'); assert.equal(calls[1].url.searchParams.get('cursor'), 'page2');
  assert.equal(calls[0].options.body, undefined);
  await client.call('files.getUploadURLExternal', { filename: 'test.json', length: 1 }); assert.equal(calls[2].options.method, 'POST');
  await assert.rejects(client.call('auth.test'), e => e.retryAfter === 30);
  const count = calls.length; await assert.rejects(client.call('auth.test')); assert.equal(calls.length, count);
  await assert.rejects(client.uploadBytes('https://evil.example/upload', Buffer.from('x')), /destination/);
  now += 31_000; await assert.rejects(client.call('auth.test')); assert.equal(calls.length, count + 1);
});

test('Linear deterministic issue ID recovers a lost mutation response without a second issue', async () => {
  let issue, writes = 0;
  const input = { id: '00000000-0000-4000-8000-000000000003', teamId: '00000000-0000-4000-8000-000000000001', title: 'Fixture', description: 'Meeting Mate action: 00000000-0000-4000-8000-000000000003' };
  const linear = new BindLinear('fixture-token', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.startsWith('mutation')) { writes++; issue = { ...input, team: { id: input.teamId } }; throw new Error('response lost'); }
    return Response.json({ data: { issue: issue ?? null } });
  } });
  await assert.rejects(linear.create(input), /linear_connection_failed/);
  assert.equal((await linear.create(input)).id, input.id); assert.equal(writes, 1);
});
