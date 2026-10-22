import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, appendFile, access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder } from '../src/recorder.mjs';

const args = { pid: 123, title: 'Meeting Mate test', url: 'https://meet.google.com/aaa-bbbb-ccc' };
async function fixture(t, { mode = 'ok', timeout = 500 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-mate-unit-'));
  let timer;
  let ending = false;
  let child;
  let events;
  let stopFile;
  let invocation;
  const validate = [];
  const close = (code = 0) => { child.exitCode = code; child.emit('close', code, null); };
  const recorder = new Recorder({ recorderApp: '/tmp/Meeting Mate Recorder.app', recordingsDir: directory,
    username: 'Yumi', segmentMs: 10000, minFreeBytes: 0 }, {
    startupTimeoutMs: timeout, stopTimeoutMs: 100,
    validate: async (file) => { validate.push(file); return { file, audio: 'aac', video: 'h264' }; },
    spawnProcess: (executable, argv) => {
      invocation = { executable, argv };
      child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null,
        kill: () => { close(137); return true; } });
      events = argv[argv.indexOf('--events') + 1];
      stopFile = argv[argv.indexOf('--stop-file') + 1];
      queueMicrotask(async () => {
        if (mode === 'spawn_error') { child.emit('error', new Error('Cannot launch app')); close(1); return; }
        if (mode === 'silent') return;
        await appendFile(events, JSON.stringify(mode === 'error' ? { event: 'error', message: 'Permission denied' } : { event: 'started' }) + '\n');
        if (mode === 'error') { close(0); return; }
        timer = setInterval(async () => {
          if (ending) return;
          if (!await access(stopFile).then(() => true, () => false)) return;
          ending = true;
          if (mode !== 'unfinished') await appendFile(events, JSON.stringify({ event: 'finished' }) + '\n');
          close(0);
        }, 10);
      });
      return child;
    },
  });
  t.after(async () => { clearInterval(timer); await recorder.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { recorder, validate, invocation: () => invocation, metadata: async () => JSON.parse(await readFile(`${recorder.file}.json`, 'utf8')) };
}
test('recorder launches through LaunchServices, verifies only after finished, and stops idempotently', async (t) => {
  const f = await fixture(t);
  await f.recorder.start(args);
  assert.equal(f.invocation().executable, '/usr/bin/open');
  assert.ok(f.invocation().argv.includes('--parent-pid'));
  assert.equal((await f.metadata()).status, 'recording');
  const first = f.recorder.stop(), second = f.recorder.stop();
  assert.equal(first, second);
  await first;
  assert.equal((await f.metadata()).status, 'verified');
  assert.equal(f.validate.length, 1);
});
test('an app launch error cannot be reported as recording', async (t) => {
  const f = await fixture(t, { mode: 'spawn_error' });
  await assert.rejects(f.recorder.start(args), /Cannot launch app/);
  assert.equal((await f.metadata()).status, 'failed');
  assert.equal(f.validate.length, 0);
});
test('native error wins even when open returns exit zero', async (t) => {
  const f = await fixture(t, { mode: 'error' });
  await assert.rejects(f.recorder.start(args), /Permission denied/);
  assert.equal((await f.metadata()).status, 'failed');
});
test('startup has a bounded timeout', async (t) => {
  const f = await fixture(t, { mode: 'silent', timeout: 30 });
  await assert.rejects(f.recorder.start(args), /before the deadline/);
  assert.equal((await f.metadata()).status, 'failed');
});
test('exit zero without a finished event is not a successful recording', async (t) => {
  const f = await fixture(t, { mode: 'unfinished' });
  await f.recorder.start(args);
  await assert.rejects(f.recorder.stop(), /did not finalize/);
  assert.equal(f.validate.length, 0);
});
