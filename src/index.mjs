import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { Browser } from './browser.mjs';
import { Monitor } from './monitor.mjs';
import { restoreSchedule } from './schedule.mjs';
import { createControlServer } from './control-server.mjs';
import { Recordings } from './recordings.mjs';
import { RecordingTests } from './recording-tests.mjs';
import { diagnostics } from './diagnostics.mjs';
import { Transcripts } from './transcripts.mjs';

const config = await loadConfig();
await fs.mkdir(path.dirname(config.statusFile), { recursive: true, mode: 0o700 });
const browser = new Browser(config);
const monitor = new Monitor(config, browser);
try {
  restoreSchedule(monitor, JSON.parse(await fs.readFile(config.statusFile, 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
}
let connected = false;
let stopped = false;
let fatal = null;
let updatedAt;
let sleeping;
let joinRequested = false;
const wake = () => { joinRequested = true; sleeping?.abort(); };
const recordingTests = new RecordingTests(config, { isBusy: () => stopped || !connected || !!fatal || monitor.isBusy(), onChange: wake });
const recordings = new Recordings(config);
const transcripts = new Transcripts(config, recordings, {
  isBusy: () => stopped || recordingTests.running || monitor.isBusy(),
  isSessionActive: (id, url) => monitor.jobs.some((job) => job.joinedAt && (id ? job.sessionId === id : job.url === url)),
  onChange: wake,
});
monitor.onSessionFinished = ({ sessionId }) => config.transcriptEnabled ? transcripts.enqueueSession(sessionId) : null;
const inspectDiagnostics = diagnostics(config, browser);
const report = () => {
  const current = monitor.jobs.find((job) => job.recorder) ?? monitor.jobs.find((job) => job.url === monitor.owner) ?? monitor.jobs.find((job) => job.page);
  const state = stopped ? 'stopped' : fatal ? 'error' : recordingTests.running ? 'testing' : monitor.pendingJoin ? 'queued' : current?.state ?? 'scheduled';
  return { apiVersion: 1, pid: process.pid, state, username: config.username, updatedAt, error: fatal,
    pendingJoinUrl: monitor.pendingJoin, recordingTestRunning: recordingTests.running, transcription: transcripts.summary(), meetings: monitor.summary() };
};

const server = createControlServer(report, (url) => {
  if (stopped || !connected || fatal) return { accepted: false, status: stopped ? 'stopping' : 'unavailable', url };
  if (recordingTests.running) return { accepted: false, status: 'busy', detail: 'A recording test is running', url };
  const result = monitor.requestJoin(url);
  if (result.accepted && result.status === 'queued') wake();
  return result;
}, {
  onControl: (action, url) => {
    if (stopped) return { accepted: false, status: 'stopping', url };
    if (action === 'resume' && recordingTests.running) return { accepted: false, status: 'busy', detail: 'A recording test is running', url };
    const result = monitor.requestControl(action, url);
    if (result.accepted) wake();
    return result;
  },
  recordings, recordingTests, transcripts, diagnostics: inspectDiagnostics,
});
// Bind before starting Chrome. A second monitor cannot accidentally join too.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.healthPort, '127.0.0.1', resolve); });
const awake = spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
awake.on('error', (error) => console.error(`Could not prevent idle sleep: ${error.message}`));
process.on('SIGTERM', () => { stopped = true; sleeping?.abort(); });
process.on('SIGINT', () => { stopped = true; sleeping?.abort(); });
console.log(`Meeting Mate: ${config.username}; health http://127.0.0.1:${config.healthPort}/healthz`);

try {
  while (!stopped) {
    try {
      if (!recordingTests.running) {
        if (!connected) { await browser.ensure(); connected = true; }
        await browser.health();
        // A test can reserve the recorder while the CDP health check awaits.
        if (!recordingTests.running) await monitor.tick();
      }
      fatal = null;
    } catch (error) {
      fatal = error.message;
      console.error(error.message);
      await monitor.shutdown();
      monitor.stopping = false;
      browser.disconnect();
      connected = false;
    }
    transcripts.pump();
    updatedAt = new Date().toISOString();
    const temp = `${config.statusFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(report(), null, 2), { mode: 0o600 });
    await fs.rename(temp, config.statusFile);
    if (joinRequested) { joinRequested = false; continue; }
    sleeping = new AbortController();
    if (!stopped) await delay(connected ? 2000 : 15000, undefined, { signal: sleeping.signal }).catch(() => {});
  }
} finally {
  await recordingTests.shutdown();
  await monitor.shutdown();
  await transcripts.shutdown();
  browser.disconnect();
  awake.kill('SIGTERM');
  updatedAt = new Date().toISOString();
  await fs.writeFile(config.statusFile, JSON.stringify(report(), null, 2), { mode: 0o600 });
  server.close();
}
