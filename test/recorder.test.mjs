import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, appendFile, access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder, parseAudioSignal, verifyRecording } from '../src/recorder.mjs';

const args = { pid: 123, title: 'Meeting Mate test', url: 'https://meet.google.com/aaa-bbbb-ccc' };
const audioStats = (peak, rms = peak) => `Peak level dB: ${peak}\nRMS level dB: ${rms}\nNumber of samples: 48000\n`;
test('signal inspection distinguishes digital silence, quiet audio and a non-silent stereo mix', () => {
  assert.deepEqual(parseAudioSignal(audioStats('-inf')), { status: 'silent', peakDB: null, rmsDB: null, samples: 48000 });
  assert.equal(parseAudioSignal(audioStats('-75')).status, 'quiet');
  assert.deepEqual(parseAudioSignal(audioStats('-inf') + audioStats('-20', '-23')),
    { status: 'signal', peakDB: -20, rmsDB: -23, samples: 48000 });
  assert.throws(() => parseAudioSignal('No audio samples'), /Could not verify/);
});
test('playable silent media remains downloadable but carries a durable audio warning', async () => {
  const calls = [];
  const media = await verifyRecording('/tmp/synthetic.mp4', { execute: async (command, argv) => {
    calls.push({ command, argv });
    if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: '1', size: '100' },
      streams: [{ codec_type: 'video', codec_name: 'h264', nb_read_frames: '15' }, { codec_type: 'audio', codec_name: 'aac', nb_read_frames: '47' }] }) };
    return { stderr: audioStats('-inf') };
  } });
  assert.equal(media.audio, 'aac'); assert.equal(media.audioSignal.status, 'silent');
  assert.match(media.warnings[0], /digital silence/);
  assert.deepEqual(calls.map(item => item.command), ['ffprobe', 'ffmpeg']);
  assert.ok(calls[1].argv.includes('astats=metadata=0:reset=0'));
});
test('fractional recording durations use valid bounded subprocess deadlines', async () => {
  for (const duration of [1.001, 224.068333, 322.056667, 900.123]) {
    await verifyRecording('/tmp/synthetic.mp4', { execute: async (command, _argv, options) => {
      assert.ok(Number.isSafeInteger(options.timeout), 'Node child processes require integer timeouts');
      if (command === 'ffprobe') return { stdout: JSON.stringify({ format: { duration: String(duration), size: '100' },
        streams: [{ codec_type: 'video', codec_name: 'h264', nb_read_frames: '15' }, { codec_type: 'audio', codec_name: 'aac', nb_read_frames: '47' }] }) };
      assert.ok(options.timeout >= 30000 && options.timeout <= 120000);
      return { stderr: audioStats('-20') };
    } });
  }
});
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
