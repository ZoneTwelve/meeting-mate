import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { command, slashCommand, validateMinutes, validateEvidence } from '../src/slack-bind-commands.mjs';
import { commandServer } from '../src/slack-command-server.mjs';
import { SlackClient } from '../src/slack-client.mjs';
import { SlackBinding } from '../src/slack-bind.mjs';
import { BindStore } from '../src/slack-bind-store.mjs';
import { BindLinear } from '../src/bind-linear.mjs';
import { bindConfig } from '../src/slack-bind-config.mjs';

// All IDs, names, tokens, and Meet links below are fictitious fixtures.
const meet = 'https://meet.google.com/abc-defg-hij';
const minutes = () => ({ decisions: [], openQuestions: [], actions: [{ title: 'Add an example', description: 'Document the fictitious example and verify it.', owner: null, assigneeId: null, dueDate: null, evidence: [{ start: 5, quote: 'Add an example.' }] }] });
function fixture() {
  let time = 1700000000000, seq = 0;
  const state = { version: 1, teamId: 'TTEST', botId: 'UBOT', startedAt: time / 1000 - 1, inbox: {}, threads: {}, processed: {}, outbox: {}, channels: {}, search: {} };
  const store = { state, save: async () => {} };
  const messages = [], uploads = [], created = [], controls = [], issues = new Map(), calls = [];
  const makeSlack = (user) => ({
    conversations: async () => [{ id: 'CTEST' }],
    messages: async (channel, { thread, oldest } = {}) => messages.filter(m => m.channel === channel && (!thread || m.thread_ts === thread || m.ts === thread) && (!oldest || Number(m.ts) >= Number(oldest))),
    search: async () => ({ messages: [], cursor: '' }),
    post: async (channel, thread_ts, text, client_msg_id) => {
      const message = { channel, thread_ts, text, client_msg_id, user, ts: `${time / 1000}.${String(++seq).padStart(6, '0')}` };
      messages.push(message); return { channel, ts: message.ts };
    },
    call: async (method, args) => {
      calls.push({ method, args });
      if (method === 'files.getUploadURLExternal') return { file_id: 'FTEST', upload_url: 'https://files.slack.com/upload/test' };
      if (method === 'files.completeUploadExternal') return { files: [{ id: 'FTEST' }] };
      if (method === 'files.info') return { file: { permalink: 'https://example.slack.com/files/UBOT/FTEST', shares: { public: { CTEST: [{ thread_ts: Object.values(state.threads)[0]?.ts }] } } } };
      throw new Error('Unexpected method');
    },
    uploadBytes: async (_url, bytes) => uploads.push(JSON.parse(bytes)),
  });
  const bot = makeSlack('UBOT'), user = makeSlack('UOWNER');
  const api = {
    jobs: [], transcripts: [], recordings: [], joins: 0,
    health: async () => ({ ok: true }), meetings: async () => ({ meetings: api.jobs }),
    join: async () => { api.joins++; return { status: 'queued' }; },
    stop: async () => controls.push('stop'), pause: async () => controls.push('pause'), resume: async () => controls.push('resume'),
    transcriptsList: async () => ({ transcripts: api.transcripts }),
    transcriptGet: async id => api.transcripts.find(t => t.id === id),
    recordingsList: async () => ({ recordings: api.recordings }),
    transcriptCreate: async () => { throw new Error('Unexpected transcript enqueue'); },
  };
  const linear = { issue: async id => issues.get(id), create: async input => {
    if (!issues.has(input.id)) { created.push(input); issues.set(input.id, { ...input, identifier: `TEST-${created.length}`, url: `https://linear.app/example/issue/TEST-${created.length}`, state: { name: 'Todo', type: 'unstarted' } }); }
    return issues.get(input.id);
  } };
  const config = { allowedUsers: [], channelIds: [], searchMs: 300_000, remindMs: 86400_000, handoff: true, linearToken: 'fictitious', linearTeamId: '00000000-0000-4000-8000-000000000001' };
  const binding = new SlackBinding({ config, store, bot, user, api, linear, identity: { bot: { user_id: 'UBOT', url: 'https://example.slack.com/' }, user: { user_id: 'UOWNER' } }, now: () => time, log: () => {} });
  const receive = async (text, extra = {}) => {
    const message = { ts: `${time / 1000}.${String(++seq).padStart(6, '0')}`, user: 'UOWNER', text, ...extra };
    messages.push({ ...message, channel: 'CTEST' }); await binding.receive(message, { id: 'CTEST' }); return message;
  };
  return { binding, state, store, bot, user, api, linear, config, messages, uploads, created, controls, issues, calls, receive, now: () => time, advance: ms => { time += ms; } };
}

test('explicit commands, Meet query normalization, and ordinary discussion boundaries', () => {
  assert.deepEqual(slashCommand(`${meet}?pli=1`), { action: 'join', url: meet, thread: undefined });
  assert.equal(slashCommand(`join <${meet}?pli=1|meeting>`).url, meet);
  assert.equal(command(meet, { direct: true }), null);
  assert.equal(command(`不要錄影 ${meet}`, { direct: true }), null);
  assert.equal(command(`meeting-mate 請不要錄影 ${meet}`), null);
  assert.equal(command(`> meeting-mate stop`, { bound: true }), null);
  assert.equal(command('[Meeting Mate] meeting-mate stop', { bound: true }), null);
  assert.equal(command(`meeting-mate join ${meet} ${meet}`).action, 'invalid');
  assert.equal(command('meeting-mate close').action, 'close');
  assert.equal(slashCommand('stop --thread 1700000000.000001').thread, '1700000000.000001');
  assert.equal(slashCommand('https://evil.example/').action, 'help');
  assert.equal(command('stop'), null);
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
  assert.deepEqual(Object.keys(accepted[0]).sort(), ['channel', 'text', 'trigger', 'user']);
  assert.equal((await request({ signature: `v0=${'0'.repeat(64)}` })).status, 401);
  assert.equal((await request({ timestamp: '1699999600' })).status, 401);
  assert.equal((await request({ timestamp: '1700000400' })).status, 401);
  assert.equal((await request({ fields: { team_id: 'TOTHER' } })).status, 403);
  assert.equal((await request({ fields: { api_app_id: 'AOTHER' } })).status, 403);
  assert.equal((await request({ fields: { text: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await request({ endpoint: '/v1/meetings/join' })).status, 404);
  assert.equal(accepted.length, 1);
});

test('slash retries create exactly one thread and one join; unauthorized users cannot enqueue', async () => {
  const f = fixture(), input = { channel: 'CTEST', user: 'UOWNER', text: `${meet}?pli=1`, trigger: 'fake-trigger' };
  await f.binding.acceptSlash({ ...input, user: 'UOTHER' }); assert.equal(Object.keys(f.state.inbox).length, 0);
  await f.binding.acceptSlash(input); await f.binding.acceptSlash(input);
  assert.equal(f.api.joins, 0); assert.equal(Object.keys(f.state.inbox).length, 1);
  await f.binding.drainSlash(); await f.binding.flush(); await f.binding.drainSlash(); await f.binding.flush();
  await f.binding.acceptSlash(input); await f.binding.drainSlash();
  assert.equal(f.api.joins, 1); assert.equal(Object.keys(f.state.threads).length, 1);
  assert.equal(f.messages.filter(m => !m.thread_ts).length, 1);
  assert.equal(Object.values(f.state.threads)[0].url, meet);
});

test('recording → local transcript → Yumi → human approval → one issue → human acceptance', async () => {
  const f = fixture(); const original = await f.receive(`meeting-mate join ${meet}`);
  const b = Object.values(f.state.threads)[0];
  await f.binding.receive(original, { id: 'CTEST' }); assert.equal(f.api.joins, 1);
  f.api.jobs = [{ url: meet, sessionId: 'session-new', state: 'recording', joinedAt: f.now(), attemptAt: f.now(), recordingFile: '/private/fictitious-recording.mp4' }];
  await f.binding.progress(); assert.equal(b.sessionId, 'session-new');
  const transcript = { id: '00000000-0000-4000-8000-000000000002', sessionId: 'session-new', state: 'completed', result: { jobId: '00000000-0000-4000-8000-000000000002', speakers: [{ id: 'S1', label: 'Speaker 1' }], segments: [{ start: 5, end: 8, text: 'Add an example.', speakerId: 'S1' }] } };
  f.api.jobs[0] = { ...f.api.jobs[0], state: 'stopped', joinedAt: null, recordingFile: null };
  f.api.transcripts = [transcript]; await f.binding.progress(); await f.binding.flush();
  assert.equal(b.stage, 'awaiting_minutes'); assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].speakersAreIdentities, false);
  assert(f.messages.some(m => m.user === 'UOWNER' && m.text.includes('[Meeting Mate] 自動交接')));
  assert.equal(f.created.length, 0);
  await f.receive(`meeting-mate minutes ${JSON.stringify(minutes())}`, { thread_ts: b.ts, user: 'UBOT', bot_id: 'BFIXTURE' });
  assert.equal(b.stage, 'awaiting_approval');
  await f.receive('meeting-mate approve', { thread_ts: b.ts }); // Preview not delivered yet.
  assert.equal(f.created.length, 0); await f.binding.flush();
  await f.receive('meeting-mate approve', { thread_ts: b.ts, user: 'UBOT', bot_id: 'BFIXTURE' });
  await f.receive('meeting-mate approve', { thread_ts: b.ts, user: 'UOTHER' });
  assert.equal(f.created.length, 0);
  await f.receive('meeting-mate approve', { thread_ts: b.ts });
  await f.receive('meeting-mate approve', { thread_ts: b.ts });
  assert.equal(f.created.length, 1); assert.equal(b.stage, 'following');
  assert.equal(f.created[0].assigneeId, undefined); assert(f.created[0].description.includes('5s：Add an example.'));
  await f.binding.deliverTranscript(b, transcript); assert.equal(b.stage, 'following'); assert.equal(f.uploads.length, 1);
  f.issues.get(b.issues[0].id).state = { name: 'Done', type: 'completed' };
  await f.binding.follow(); assert.equal(b.stage, 'awaiting_acceptance');
  await f.receive('meeting-mate close', { thread_ts: b.ts }); assert.equal(b.stage, 'closed');
});

test('outbox reconciles a lost Slack response after restart without duplicating a reply', async () => {
  const f = fixture(); const post = f.bot.post;
  f.bot.post = async (...args) => { await post(...args); throw new Error('fixture network loss'); };
  await f.binding.emit('root-test', { channel: 'CTEST' }, '[Meeting Mate] Test receipt');
  await f.binding.flush(); assert.equal(f.messages.length, 1);
  f.advance(16_000); f.bot.post = post; await f.binding.flush();
  assert.equal(f.messages.length, 1); assert.equal(Object.values(f.state.outbox)[0].state, 'sent');
});

test('a replacement draft cannot change approved work while issue creation is retrying', async () => {
  const f = fixture(); await f.receive(`meeting-mate join ${meet}`);
  const b = Object.values(f.state.threads)[0];
  b.transcriptId = 'fixture'; b.minutes = minutes(); b.approvedAt = f.now(); b.stage = 'creating_issues';
  f.api.transcriptGet = async () => { throw new Error('Must not fetch replacement transcript'); };
  const replacement = minutes(); replacement.actions[0].title = 'Unapproved replacement';
  await f.receive(`meeting-mate minutes ${JSON.stringify(replacement)}`, { thread_ts: b.ts });
  assert.equal(b.minutes.actions[0].title, 'Add an example'); assert.equal(b.stage, 'creating_issues');
});

test('ack waits for persistence; concurrent delivery does not execute or ack an uncommitted command', async () => {
  const f = fixture(); let resolve, reject;
  f.store.save = () => new Promise((yes, no) => { resolve = yes; reject = no; });
  const input = { channel: 'CTEST', user: 'UOWNER', trigger: 'persist-test', text: meet };
  let acked = false;
  const pending = f.binding.acceptSlash(input).then(() => { acked = true; });
  const duplicate = f.binding.acceptSlash(input);
  await f.binding.drainSlash(); assert.equal(f.api.joins, 0); assert.equal(acked, false);
  resolve(); await Promise.all([pending, duplicate]); assert.equal(acked, true);
  const failure = f.binding.acceptSlash({ ...input, trigger: 'persist-failure' });
  reject(new Error('Fixture disk full')); await assert.rejects(failure);
  assert.equal(Object.keys(f.state.inbox).length, 1);
});

test('search resumes fixed-window pagination after restart; a busy page is not skipped', async () => {
  const f = fixture(); let calls = [];
  f.user.search = async (query, after, before, cursor) => { calls.push({ query, after, before, cursor }); return { messages: [], cursor: cursor ? '' : 'fixture-next-page' }; };
  await f.binding.search(); const initial = calls[0];
  assert.equal(f.state.search[initial.query].cursor, 'fixture-next-page');
  f.advance(301_000); await f.binding.search();
  assert.equal(calls[2].after, initial.after); assert.equal(calls[2].before, initial.before); assert.equal(calls[2].cursor, 'fixture-next-page');
  assert.equal(f.state.search[initial.query].after, undefined);
});

test('long draft is not accepted unseen, and a reopened Linear issue prevents close', async () => {
  const f = fixture(); await f.receive(`meeting-mate join ${meet}`); const b = Object.values(f.state.threads)[0];
  b.transcriptId = 'fixture'; f.api.transcriptGet = async () => ({ state: 'completed', result: { segments: [{ start: 5, text: 'Add an example.' }] } });
  const long = minutes(); long.actions = Array.from({ length: 8 }, () => ({ ...long.actions[0], description: 'x'.repeat(3900) }));
  await f.receive(`meeting-mate minutes ${JSON.stringify(long)}`, { thread_ts: b.ts });
  assert.equal(b.minutes, undefined);
  b.stage = 'awaiting_acceptance'; b.issues = [{ id: 'fixture-issue' }];
  f.issues.set('fixture-issue', { state: { type: 'started' } });
  await f.receive('meeting-mate close', { thread_ts: b.ts }); assert.equal(b.stage, 'following');
});

test('does not capture stale sessions, control another session, or accept fabricated evidence', async () => {
  const f = fixture(); f.api.jobs = [{ url: meet, sessionId: 'old', state: 'stopped' }];
  await f.receive(`meeting-mate join ${meet}`); const b = Object.values(f.state.threads)[0];
  await f.binding.progress(); assert.equal(b.sessionId, undefined);
  f.api.jobs = [{ url: meet, sessionId: 'new', attemptAt: f.now(), state: 'recording', joinedAt: f.now() }];
  await f.binding.progress(); assert.equal(b.sessionId, 'new');
  f.api.jobs[0].sessionId = 'other';
  await f.receive('meeting-mate stop', { thread_ts: b.ts }); assert.deepEqual(f.controls, []);
  delete b.sessionId; delete b.joinReceipt;
  f.api.jobs[0].sessionId = 'old';
  await f.receive('meeting-mate stop', { thread_ts: b.ts }); assert.deepEqual(f.controls, []);
  assert.throws(() => validateEvidence(validateMinutes(minutes()), { segments: [{ start: 100, text: 'Different words.' }] }), /紀要依據/);
});

test('bounded commands reject ambiguous slash controls and bot control loops', async () => {
  const f = fixture();
  f.state.threads.a = { key: 'a', channel: 'CTEST', ts: '1700000000.000001', requester: 'UOWNER', stage: 'following', url: meet };
  f.state.threads.b = { key: 'b', channel: 'CTEST', ts: '1700000000.000002', requester: 'UOWNER', stage: 'following', url: meet };
  assert.match(await f.binding.acceptSlash({ channel: 'CTEST', user: 'UOWNER', trigger: 'x', text: 'stop' }), /多個/);
  assert.equal(Object.keys(f.state.inbox).length, 0);
  await f.receive(`meeting-mate join ${meet}`, { user: 'UOTHER', bot_id: 'BFIXTURE' });
  assert.equal(f.api.joins, 0);
});

test('login rejection is actionable, and explicit retry attaches only a new session after sign-in', async () => {
  const f = fixture(); f.api.jobs = [{ url: meet, state: 'needs_login', sessionId: 'old-session' }];
  f.api.join = async () => { throw Object.assign(new Error('fixture login required'), { code: 'http_error', httpStatus: 409, details: { status: 'needs_login' } }); };
  await f.receive(`meeting-mate join ${meet}`); const b = Object.values(f.state.threads)[0];
  assert.equal(b.stage, 'needs_login'); assert(Object.values(f.state.outbox).some(x => x.text.includes('專用 Chrome')));
  f.api.jobs[0] = { url: meet, state: 'recording', sessionId: 'old-session', joinedAt: f.now() };
  await f.receive('meeting-mate retry', { thread_ts: b.ts }); assert.equal(b.sessionId, undefined);
  f.api.jobs[0].sessionId = 'new-after-login';
  await f.receive('meeting-mate retry', { thread_ts: b.ts }); assert.equal(b.sessionId, 'new-after-login');
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
    if (url.pathname.endsWith('/files.getUploadURLExternal')) return Response.json({ ok: true, file_id: 'FTEST' });
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

test('env file is parsed as data; signed listener can be disabled explicitly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-bind-config-'));
  await writeFile(path.join(directory, '.env.yumi'), 'USER_OAUTH_TOKEN=fake-user\nBOT_USER_OAUTH_TOKEN=fake-bot\nSLACK_BIND_PORT=0\n');
  const config = await bindConfig(directory, {}); assert.equal(config.port, 0); assert.equal(config.pollMs, 30_000);
  await assert.rejects(bindConfig(directory, { SLACK_BIND_PORT: '18007' }), /SIGNING_SECRET/);
});
