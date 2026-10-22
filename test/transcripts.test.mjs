import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Transcripts } from '../src/transcripts.mjs';
import { Recordings } from '../src/recordings.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { formatTranscript, validateTranscript } from '../src/transcript-format.mjs';

const url = 'https://meet.google.com/abc-defg-hij';
const sessionId = 'test-session';
async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'meeting-mate-transcripts-'));
  const config = normalizeConfig({ meetingUrls: [url], minimumFreeGB: 0 }, { MEET_USERNAME: 'Yumi' }, rootDir);
  await mkdir(config.recordingsDir, { recursive: true });
  await mkdir(path.dirname(config.transcriptPython), { recursive: true });
  await writeFile(config.transcriptPython, 'fake Python');
  const add = async (id = 'meeting-1.mp4', metadata = {}) => {
    await writeFile(path.join(config.recordingsDir, id), 'fake media');
    await writeFile(path.join(config.recordingsDir, `${id}.json`), JSON.stringify({ meetingUrl: url, sessionId,
      status: 'verified', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:10Z', media: { duration: 10 }, ...metadata }));
    return id;
  };
  const recordingId = await add();
  const children = [];
  const manager = new Transcripts(config, new Recordings(config), { rootDir, ...options, spawnProcess: (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, signal)); };
    children.push({ child, command, args, opts });
    return child;
  } });
  t.after(async () => { await manager.shutdown(); await rm(rootDir, { recursive: true, force: true }); });
  const running = async () => {
    manager.pump();
    for (let attempt = 0; attempt < 100 && !children.length; attempt++) await delay(2);
    assert.ok(children.length, 'worker was launched');
    return children.at(-1);
  };
  const complete = async (job, { result, code = 0 } = {}) => {
    const child = children.at(-1).child;
    await writeFile(manager.paths(job.id).output, JSON.stringify(result ?? {
      jobId: job.id, language: 'zh', duration: 10, speakers: [{ id: 'speaker_1', label: 'Speaker 1' }],
      segments: [{ start: 1, end: 2, speakerId: 'speaker_1', text: '大家好', recordingId }],
    }));
    const done = manager.active.done;
    child.emit('close', code, null);
    await done;
    return manager.get(job.id);
  };
  return { rootDir, config, recordingId, manager, children, add, running, complete };
}

test('completed session queues once and includes every segment with wall-clock offsets', async (t) => {
  const f = await fixture(t);
  await f.add('meeting-2.mp4', { startedAt: '2026-01-01T00:00:20Z' });
  const [first, duplicate] = await Promise.all([f.manager.create({ recordingId: f.recordingId }), f.manager.create({ recordingId: 'meeting-2.mp4' })]);
  assert.equal(first.id, duplicate.id);
  assert.deepEqual(first.recordings.map((item) => item.offsetSeconds), [0, 20]);
  assert.equal(first.recordings.some((item) => Object.hasOwn(item, 'file')), false);
  assert.equal(f.children.length, 0);
  assert.equal(f.manager.summary().queued, 1);
});
test('active, unfinalized, missing, invalid and unsafe sources are refused', async (t) => {
  const f = await fixture(t);
  f.manager.isSessionActive = () => true;
  await assert.rejects(f.manager.create({ recordingId: f.recordingId }), { statusCode: 409 });
  f.manager.isSessionActive = () => false;
  await f.add('meeting-2.mp4', { status: 'recording' });
  await assert.rejects(f.manager.create({ recordingId: f.recordingId }), { statusCode: 409 });
  await assert.rejects(f.manager.create({ recordingId: '../secret.mp4' }), { statusCode: 400 });
  await assert.rejects(f.manager.create({ recordingId: f.recordingId, language: 'shell; cmd' }), { statusCode: 400 });
  await assert.rejects(f.manager.create({ recordingId: f.recordingId, numSpeakers: 0 }), { statusCode: 400 });
  await assert.rejects(f.manager.get('../secret'), { statusCode: 400 });
  assert.throws(() => f.manager.list(101), { statusCode: 400 });
});
test('worker runs offline, reports progress and produces validated readable exports', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create({ recordingId: f.recordingId });
  const worker = await f.running();
  assert.equal(worker.command, f.config.transcriptPython);
  assert.equal(worker.opts.env.HF_HUB_OFFLINE, '1');
  assert.equal(worker.opts.detached, true);
  worker.child.stdout.write('{"phase":"diarizing","progress":40}\n');
  assert.equal((await f.manager.get(job.id)).phase, 'diarizing');
  const done = await f.complete(job);
  assert.equal(done.state, 'completed');
  assert.equal(done.result.segments[0].text, '大家好');
  assert.match((await f.manager.file(job.id, 'txt')).text, /Speaker 1: 大家好/);
  assert.match((await f.manager.file(job.id, 'srt')).text, /00:00:01,000 --> 00:00:02,000/);
  assert.match((await f.manager.file(job.id, 'vtt')).text, /^WEBVTT/);
  assert.match(await readFile(path.join(f.config.transcriptsDir, `${job.id}.txt`), 'utf8'), /大家好/);
  assert.equal((await f.manager.create({ recordingId: f.recordingId })).id, job.id);
  await assert.rejects(f.manager.file(job.id, '../secret'), { statusCode: 400 });
});
test('busy recording defers worker launch, and later suspends only its own worker', async (t) => {
  let busy = true;
  const f = await fixture(t, { isBusy: () => busy });
  const job = await f.manager.create({ recordingId: f.recordingId });
  f.manager.pump();
  assert.equal(f.children.length, 0);
  busy = false;
  const { child } = await f.running();
  busy = true; f.manager.pump();
  assert.deepEqual(child.signals, ['SIGSTOP']);
  assert.equal((await f.manager.get(job.id)).suspended, true);
  busy = false; f.manager.pump();
  assert.deepEqual(child.signals, ['SIGSTOP', 'SIGCONT']);
  await f.complete(job);
});
test('stale output and nonzero worker exit cannot become successful transcripts', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create({ recordingId: f.recordingId });
  await f.running();
  assert.equal((await f.complete(job, { result: { jobId: 'wrong', speakers: [], segments: [], duration: 0 } })).state, 'failed');
  const retry = await f.manager.create({ recordingId: f.recordingId });
  assert.notEqual(retry.id, job.id);
  f.manager.pump();
  for (let attempt = 0; attempt < 100 && f.children.length < 2; attempt++) await delay(2);
  assert.equal((await f.complete(retry, { code: 1 })).state, 'failed');
});
test('shutdown preserves queued work and restarts interrupted work without losing history', async (t) => {
  const f = await fixture(t);
  const queued = f.manager.create({ recordingId: f.recordingId });
  await f.manager.shutdown();
  const job = await queued;
  assert.equal((await f.manager.get(job.id)).state, 'queued');
  await assert.rejects(f.manager.create({ recordingId: f.recordingId }), { statusCode: 503 });
  const resumed = new Transcripts(f.config, new Recordings(f.config), { rootDir: f.rootDir });
  assert.equal(resumed.list()[0].id, job.id);
});
test('shutdown gracefully interrupts running worker and keeps job queued for restart', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create({ recordingId: f.recordingId });
  const { child } = await f.running();
  await f.manager.shutdown();
  assert.ok(child.signals.includes('SIGTERM'));
  assert.equal((await f.manager.get(job.id)).state, 'queued');
});
test('result validation rejects nonexistent speakers and timestamps outside source', () => {
  const job = { id: 'job', recordings: [{ id: 'a', duration: 10, offsetSeconds: 0 }] };
  const result = { jobId: 'job', duration: 10, speakers: [{ id: 'speaker_1', label: 'Speaker 1' }],
    segments: [{ start: 0, end: 1, speakerId: 'speaker_1', recordingId: 'a', text: 'hello' }] };
  assert.equal(validateTranscript(result, job), result);
  assert.throws(() => validateTranscript({ ...result, segments: [{ ...result.segments[0], speakerId: 'speaker_2' }] }, job));
  assert.throws(() => validateTranscript({ ...result, segments: [{ ...result.segments[0], end: 30 }] }, job));
  assert.equal(formatTranscript({ ...result, segments: [] }, 'vtt'), 'WEBVTT\n\n');
});
