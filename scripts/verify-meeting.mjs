import { constants } from 'node:fs';
import { open, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiClient } from '../src/api-client.mjs';
import { loadConfig, root } from '../src/config.mjs';
import { Recordings } from '../src/recordings.mjs';
import { verifyRecording } from '../src/recorder.mjs';
import { validationManifest, sessionIsActive, evaluateMeetingValidation } from '../src/meeting-validation.mjs';

const help = 'Usage: pnpm run verify:meeting -- --manifest <private-manifest.json> [--timeout-seconds 1200]\nWaits for the selected meeting to end, verifies every MP4 locally, and checks the actual offline Whisper result and all four exports. It does not open, join, stop, or restart a meeting.';

async function main() {
  const args = process.argv.slice(2).filter((value, index) => value !== '--' || index !== 0);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--manifest', '--timeout-seconds'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) throw new Error(help);
    options[args[index]] = args[index + 1];
  }
  const timeout = Number(options['--timeout-seconds'] ?? 1200);
  if (!options['--manifest'] || !Number.isInteger(timeout) || timeout < 30 || timeout > 86400) throw new Error(help);
  let input;
  const handle = await open(path.resolve(options['--manifest']), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('Validation manifest must be a regular file under 64 KiB');
    input = validationManifest(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }

  const config = await loadConfig();
  const api = createApiClient(config);
  const catalog = new Recordings(config);
  const id = randomUUID();
  const directory = path.join(root, '.meeting-mate', 'validation');
  const filename = path.join(directory, `closed-loop-${id}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { id, startedAt: new Date().toISOString(), state: 'running', manifest: input,
    evidence: 'local API, native MP4 decode, offline Whisper worker, export downloads' };
  const save = async () => {
    const temporary = `${filename}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
  };
  let phase;
  const progress = async next => {
    if (phase !== next) { phase = report.phase = next; await save(); console.log(JSON.stringify({ phase: next })); }
  };
  const deadline = Date.now() + timeout * 1000;
  const wait = async (read, ready, label) => {
    await progress(label);
    while (true) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() >= deadline) throw new Error('Controlled meeting validation timed out');
      await delay(1000);
    }
  };

  try {
    await wait(() => api.health(), health => !sessionIsActive(health, input), 'waiting_for_meeting_end');
    let jobs = await api.transcriptsList(100);
    let job = jobs.transcripts.find(item => item.sessionId === input.sessionId);
    if (!job) {
      const recordings = await api.recordingsList(100);
      const recording = recordings.recordings.find(item => item.sessionId === input.sessionId);
      if (!recording) throw new Error('No recording from the controlled session is available');
      // A mutation is sent once. A timeout never causes a blind resubmission.
      job = await api.transcriptCreate({ recordingId: recording.id }, { idempotencyKey: `validation-${id}` });
    }
    report.transcriptId = job.id;
    job = await wait(async () => {
      const current = await api.transcriptGet(job.id);
      if (current.state === 'failed') throw new Error('The local Whisper worker failed');
      return current;
    }, current => current.state === 'completed', 'waiting_for_whisper');
    report.transcript = job;
    await progress('verifying_recordings');
    const inspections = [];
    for (const source of job.recordings) {
      const { handle: mediaHandle, recording } = await catalog.openFile(source.id);
      try {
        const before = await mediaHandle.stat();
        const media = await verifyRecording(recording.file);
        const after = await mediaHandle.stat();
        const current = await catalog.openFile(source.id);
        try {
          const located = await current.handle.stat();
          if (before.ino !== located.ino || before.dev !== located.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            throw new Error('Recording changed during inspection');
          }
        } finally { await current.handle.close(); }
        inspections.push({ id: source.id, status: recording.status, available: recording.available,
          sessionId: recording.sessionId, startedAt: recording.startedAt, bytes: before.size, modifiedAt: before.mtimeMs,
          containerVerified: true, duration: media.duration, frames: media.frames, audioFrames: media.audioFrames,
          audioSignal: media.audioSignal });
      } finally { await mediaHandle.close(); }
    }
    report.inspections = inspections;
    await progress('checking_content_and_exports');
    const health = await api.health();
    report.validation = evaluateMeetingValidation(input, { health, job, inspections });
    report.exports = {};
    for (const format of ['json', 'txt', 'srt', 'vtt']) {
      const response = await fetch(`http://127.0.0.1:${config.healthPort}/v1/transcripts/${job.id}/file?format=${format}`,
        { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('A transcript export could not be downloaded');
      const content = await response.text();
      if (Buffer.byteLength(content) > 22 * 1024 ** 2 || !content.trim() ||
        (format === 'json' && JSON.parse(content).jobId !== job.id) ||
        (format === 'vtt' && !content.startsWith('WEBVTT')) ||
        (format === 'srt' && !content.includes(' --> '))) throw new Error('A transcript export is invalid or empty');
      report.exports[format] = { bytes: Buffer.byteLength(content), status: response.status };
    }
    report.state = report.validation.passed ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ state: report.state, ...report.validation.metrics,
      failures: report.validation.failures, report: path.relative(root, filename) }));
    if (!report.validation.passed) process.exitCode = 1;
  } catch (error) {
    Object.assign(report, { state: 'failed', finishedAt: new Date().toISOString(), error: error.message });
    await save();
    console.log(JSON.stringify({ state: 'failed', phase, report: path.relative(root, filename) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(help); process.exitCode = 1; });
}
