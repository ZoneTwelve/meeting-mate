import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecordingTests } from '../src/recording-tests.mjs';

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'meeting-mate-recording-tests-'));
  const calls = [], children = [], changes = [];
  const config = { statusFile: path.join(rootDir, '.meeting-mate', 'status.json') };
  const smokeDirectory = path.join(rootDir, '.meeting-mate', 'smoke');
  const directory = path.join(rootDir, '.meeting-mate', 'recording-tests');
  const spawnProcess = (executable, args, settings) => {
    calls.push({ executable, args, settings });
    const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signals: [] });
    child.close = (code = 0, signal = null) => { child.exitCode = code; child.emit('close', code, signal); };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (options.closeOnKill !== false) child.close(null, signal);
      return true;
    };
    children.push(child);
    return child;
  };
  const runner = new RecordingTests(config, { rootDir, timeoutMs: 2000, stopTimeoutMs: 20,
    isBusy: options.isBusy, spawnProcess: options.spawnProcess ?? spawnProcess,
    onChange: (job) => { changes.push(job); options.onChange?.(job); }, ...options.runnerOptions });
  t.after(async () => { await runner.shutdown(); await rm(rootDir, { recursive: true, force: true }); });
  const report = async (job, fields = {}) => {
    await mkdir(smokeDirectory, { recursive: true });
    const file = path.join(smokeDirectory, `${job.id}.mp4`);
    await writeFile(file, 'fake media fixture');
    const value = { jobId: job.id, startedAt: job.startedAt, verifiedAt: new Date().toISOString(), file,
      duration: 10.03, bytes: Buffer.byteLength('fake media fixture'), video: 'h264', audio: 'aac',
      frames: 149, audioFrames: 470, maxVolumeDB: -31.8, distinctFrames: 20, ...fields };
    await writeFile(path.join(smokeDirectory, 'report.json'), JSON.stringify(value));
    return value;
  };
  return { rootDir, config, directory, smokeDirectory, runner, calls, children, changes, report,
    saved: async (id) => JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')),
    start: async () => { const job = runner.start(); await Promise.resolve(); return job; } };
}

async function settled(runner) {
  for (let attempt = 0; attempt < 200 && runner.running; attempt++) await delay(5);
  assert.equal(runner.running, false, 'job should settle within the test deadline');
  return runner.get();
}

test('busy meetings and pending requests refuse smoke without spawning', async (t) => {
  const f = await fixture(t, { isBusy: () => true });
  assert.throws(() => f.runner.start(), (error) => error.statusCode === 409);
  await Promise.resolve();
  assert.equal(f.runner.running, false);
  assert.equal(f.runner.get(), null);
  assert.equal(f.calls.length, 0);
});

test('start reserves synchronously and launches only one smoke process in the project root', async (t) => {
  const f = await fixture(t);
  const job = f.runner.start();
  assert.equal(job.state, 'running');
  assert.equal(f.runner.running, true);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.runner.start(), (error) => error.statusCode === 409);
  assert.doesNotThrow(() => JSON.stringify(job));
  await Promise.resolve();
  const [call] = f.calls;
  assert.equal(f.calls.length, 1);
  assert.equal(call.executable, process.execPath);
  assert.deepEqual(call.args, [path.join(f.rootDir, 'scripts', 'smoke.mjs')]);
  assert.equal(call.settings.cwd, f.rootDir);
  assert.equal(call.settings.env.MEETING_MATE_SMOKE_JOB_ID, job.id);
  assert.deepEqual(call.settings.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal((await f.saved(job.id)).state, 'running');
  f.children[0].close(1);
});

test('a fresh valid report and exit zero pass, with durable and immutable query results', async (t) => {
  const f = await fixture(t);
  const job = await f.start();
  const report = await f.report(job);
  f.children[0].stdout.write('native recording started\n');
  f.children[0].close(0);
  const result = f.runner.get(job.id);
  assert.equal(result.state, 'passed');
  assert.equal(f.runner.running, false);
  assert.deepEqual(result.report, report);
  assert.ok(result.finishedAt);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await f.saved(job.id), result);
  result.report.frames = 0;
  result.state = 'failed';
  assert.equal(f.runner.get().report.frames, 149);
  assert.equal(f.runner.get().state, 'passed');
  assert.equal(f.runner.get('unknown'), null);
  assert.deepEqual(f.changes.map((change) => change.state), ['running', 'passed']);
  const restored = new RecordingTests(f.config, { rootDir: f.rootDir });
  assert.equal(restored.running, false);
  assert.deepEqual(restored.get(job.id), f.runner.get(job.id));
  await restored.shutdown();
});

test('an old success report cannot make a new exit-zero job pass', async (t) => {
  const f = await fixture(t);
  await f.report({ id: randomUUID(), startedAt: new Date(Date.now() - 60_000).toISOString() });
  const job = await f.start();
  f.children[0].close(0);
  assert.equal(f.runner.get(job.id).state, 'failed');
  assert.match(f.runner.get().error, /does not belong to this test run/);
  assert.equal(f.runner.get().report, null);
});

test('missing or invalid report data cannot pass despite exit zero', async (t) => {
  for (const [label, fields] of [
    ['no report', null], ['silent audio', { maxVolumeDB: -80 }], ['static video', { distinctFrames: 1 }],
    ['missing audio', { audioFrames: 0 }], ['invalid metrics', { duration: '10' }],
    ['old timestamps', { startedAt: '2000-01-01T00:00:00.000Z' }],
    ['outside smoke directory', { file: '/tmp/unrelated-recording.mp4' }], ['wrong size', { bytes: 12345 }],
  ]) await t.test(label, async (subtest) => {
    const f = await fixture(subtest);
    const job = await f.start();
    if (fields) await f.report(job, fields);
    f.children[0].close(0);
    assert.equal(f.runner.get().state, 'failed');
    assert.equal(f.runner.get().report, null);
    assert.ok(f.runner.get().error);
  });
});

test('nonzero or signalled exits fail even with a valid report', async (t) => {
  for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) await t.test(String(signal ?? code), async (subtest) => {
    const f = await fixture(subtest);
    const job = await f.start();
    await f.report(job);
    f.children[0].close(code, signal);
    assert.equal(f.runner.get().state, 'failed');
    assert.equal(f.runner.get().report, null);
  });
});

test('spawn failures settle the job and release the reservation', async (t) => {
  const f = await fixture(t, { spawnProcess: () => { throw new Error('Cannot launch smoke'); } });
  const initial = f.runner.start();
  assert.equal(initial.state, 'running');
  await Promise.resolve();
  assert.equal(f.runner.running, false);
  assert.match(f.runner.get().error, /Cannot launch smoke/);
  assert.equal((await f.saved(initial.id)).state, 'failed');
  assert.notEqual((await f.start()).id, initial.id);
});

test('an asynchronous spawn error settles once even if close follows', async (t) => {
  const f = await fixture(t);
  await f.start();
  delete f.children[0].pid;
  f.children[0].emit('error', new Error('ENOENT'));
  f.children[0].close(-2);
  assert.equal(f.runner.running, false);
  assert.equal(f.runner.get().state, 'failed');
  assert.match(f.runner.get().error, /ENOENT/);
  assert.equal(f.changes.length, 2);
});

test('a deadline requests graceful termination and cannot pass on a late report', async (t) => {
  const f = await fixture(t, { closeOnKill: false, runnerOptions: { timeoutMs: 100, stopTimeoutMs: 200 } });
  const job = await f.start();
  await f.report(job);
  for (let attempt = 0; attempt < 100 && !f.children[0].signals.length; attempt++) await delay(5);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.equal(f.runner.running, true);
  assert.throws(() => f.runner.start(), (error) => error.statusCode === 409);
  f.children[0].close(0);
  assert.equal(f.runner.get().state, 'timed_out');
  assert.equal(f.runner.get().report, null);
});

test('an unresponsive child is killed and eventually settled without a close event', async (t) => {
  const f = await fixture(t, { closeOnKill: false, runnerOptions: { timeoutMs: 15, stopTimeoutMs: 15 } });
  await f.start();
  const result = await settled(f.runner);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.state, 'timed_out');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal((await f.saved(result.id)).state, 'timed_out');
});

test('shutdown waits for its child, is idempotent, and forbids new jobs', async (t) => {
  const f = await fixture(t, { closeOnKill: false, runnerOptions: { stopTimeoutMs: 500 } });
  await f.start();
  const first = f.runner.shutdown();
  assert.equal(first, f.runner.shutdown());
  assert.equal(f.runner.running, true);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.throws(() => f.runner.start(), (error) => error.statusCode === 503);
  f.children[0].close(0);
  await first;
  assert.equal(f.runner.get().state, 'cancelled');
  assert.equal(f.runner.running, false);
});

test('shutdown immediately after reservation cancels without launching', async (t) => {
  const f = await fixture(t);
  f.runner.start();
  await f.runner.shutdown();
  assert.equal(f.calls.length, 0);
  assert.equal(f.runner.get().state, 'cancelled');
  assert.equal(f.runner.running, false);
});

test('stdout and stderr retain a bounded tail and observer exceptions do not break jobs', async (t) => {
  const f = await fixture(t, { onChange: () => { throw new Error('Observer error'); } });
  const job = await f.start();
  f.children[0].stdout.write('x'.repeat(100_000));
  f.children[0].stderr.write('\nlast diagnostic\n');
  await f.report(job);
  f.children[0].close(0);
  const result = f.runner.get();
  assert.equal(result.state, 'passed');
  assert.equal(result.logsTruncated, true);
  assert.equal(result.logs.length, 16_384);
  assert.ok(result.logs.endsWith('last diagnostic\n'));
  assert.equal((await f.saved(job.id)).logs, result.logs);
});

test('restart recovers interrupted jobs as failed and tolerates corrupt files', async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  const id = randomUUID();
  await writeFile(path.join(f.directory, `${id}.json`), JSON.stringify({ id, state: 'running',
    startedAt: new Date().toISOString(), logs: 'was recording', report: null }));
  await writeFile(path.join(f.directory, `${randomUUID()}.json`), '{incomplete');
  const restored = new RecordingTests(f.config, { rootDir: f.rootDir });
  assert.equal(restored.running, false);
  assert.equal(restored.get(id).state, 'failed');
  assert.match(restored.get(id).error, /restarted/);
  assert.equal((await f.saved(id)).state, 'failed');
  await restored.shutdown();
});

test('only the latest twenty jobs are retained, with stable latest lookup after restart', async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let index = 0; index < 23; index++) {
    const job = await f.start();
    ids.push(job.id);
    f.children[index].close(1);
  }
  assert.equal(f.runner.get(ids[0]), null);
  assert.equal(f.runner.get(ids[2]), null);
  assert.equal(f.runner.get(ids[3]).state, 'failed');
  assert.equal((await readdir(f.directory)).filter((file) => file.endsWith('.json')).length, 20);
  const restored = new RecordingTests(f.config, { rootDir: f.rootDir });
  assert.equal(restored.get().id, ids.at(-1));
  assert.equal(restored.get(ids[0]), null);
  await restored.shutdown();
});
