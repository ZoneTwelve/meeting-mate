import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './config.mjs';

const MAX_JOBS = 20;
const MAX_LOG_LENGTH = 16_384;
const MAX_REPORT_BYTES = 65_536;
const STATES = new Set(['running', 'passed', 'failed', 'timed_out', 'cancelled']);
const identifier = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const copy = (value) => value ? structuredClone(value) : null;
const message = (error) => String(error?.message ?? error).slice(-4096);
const problem = (text, statusCode) => Object.assign(new Error(text), { statusCode });

export class RecordingTests {
  // The optional clock limits and rootDir allow isolated tests without starting
  // Chrome or the native recorder. Production uses the repository root.
  constructor(config, { isBusy = () => false, onChange = () => {}, spawnProcess = spawn,
    timeoutMs = 90_000, stopTimeoutMs = 15_000, rootDir = root } = {}) {
    if (![timeoutMs, stopTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('Recording test timeouts must be positive numbers');
    }
    Object.assign(this, { config, isBusy, onChange, spawnProcess, timeoutMs, stopTimeoutMs, rootDir });
    this.directory = path.join(rootDir, '.meeting-mate', 'recording-tests');
    this.smokeDirectory = path.join(rootDir, '.meeting-mate', 'smoke');
    this.jobs = [];
    this.active = null;
    this.stopping = false;
    this.restore();
  }

  get running() { return this.active !== null; }

  get(id = 'latest') {
    return copy(id === 'latest' ? this.jobs[0] : this.jobs.find((job) => job.id === id));
  }

  start() {
    if (this.stopping) throw problem('Recording test runner is shutting down', 503);
    if (this.running || this.isBusy()) throw problem('A meeting or recording test is already active or pending', 409);
    const job = { id: randomUUID(), sequence: (this.jobs[0]?.sequence ?? 0) + 1,
      state: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, signal: null, error: null, logs: '', logsTruncated: false, report: null };
    const active = { job, child: null, finishing: false, reason: null };
    active.done = new Promise((resolve) => { active.resolve = resolve; });
    // Reserve before invoking callbacks or queuing any asynchronous work.
    this.active = active;
    this.jobs.unshift(job);
    try { this.save(job); }
    catch (error) {
      this.jobs.shift(); this.active = null; active.resolve();
      throw error;
    }
    this.prune();
    const result = copy(job);
    active.timer = setTimeout(() => this.terminate(active, 'timed_out', `Recording test exceeded ${this.timeoutMs}ms`), this.timeoutMs);
    queueMicrotask(() => this.launch(active));
    this.changed(job);
    return result;
  }

  launch(active) {
    if (this.active !== active || active.finishing) return;
    try {
      const child = active.child = this.spawnProcess(process.execPath, [path.join(this.rootDir, 'scripts', 'smoke.mjs')], {
        cwd: this.rootDir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MEETING_MATE_SMOKE_JOB_ID: active.job.id },
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk) => {
          if (active.finishing) return;
          const text = active.job.logs + chunk.toString();
          active.job.logsTruncated ||= text.length > MAX_LOG_LENGTH;
          active.job.logs = text.slice(-MAX_LOG_LENGTH);
        });
      }
      child.once('close', (code, signal) => this.finish(active, code, signal));
      child.on('error', (error) => {
        if (active.finishing) return;
        if (child.pid) this.terminate(active, 'failed', message(error));
        else {
          active.reason ??= { state: 'failed', error: message(error) };
          this.finish(active, null, null);
        }
      });
    } catch (error) {
      active.reason ??= { state: 'failed', error: message(error) };
      this.finish(active, null, null);
    }
  }

  terminate(active, state, error) {
    if (this.active !== active || active.finishing || active.reason) return;
    active.reason = { state, error };
    clearTimeout(active.timer);
    if (!active.child) { this.finish(active, null, null); return; }
    // Only signal the child created by this runner, never Chrome or a Meet tab.
    try { active.child.kill('SIGTERM'); } catch (killError) { active.job.logs = (active.job.logs + '\n' + message(killError)).slice(-MAX_LOG_LENGTH); }
    if (active.finishing) return;
    active.killTimer = setTimeout(() => {
      try { active.child.kill('SIGKILL'); } catch {}
      if (active.finishing) return;
      // A broken launcher may never emit close, even after SIGKILL.
      active.settleTimer = setTimeout(() => this.finish(active, null, 'SIGKILL'), Math.min(this.stopTimeoutMs, 1000));
    }, this.stopTimeoutMs);
  }

  readReport(job) {
    const filename = path.join(this.smokeDirectory, 'report.json');
    if (statSync(filename).size > MAX_REPORT_BYTES) throw new Error('Smoke report is too large');
    const report = JSON.parse(readFileSync(filename, 'utf8'));
    if (!report || report.jobId !== job.id) throw new Error('Smoke report does not belong to this test run');
    const startedAt = Date.parse(report.startedAt), verifiedAt = Date.parse(report.verifiedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(verifiedAt) || startedAt < Date.parse(job.startedAt) ||
      verifiedAt < startedAt || verifiedAt > Date.now() + 1000) throw new Error('Smoke report has invalid run timestamps');
    if (![report.duration, report.bytes, report.frames, report.audioFrames].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) ||
      ![report.bytes, report.frames, report.audioFrames, report.distinctFrames].every(Number.isSafeInteger) ||
      typeof report.video !== 'string' || !report.video || typeof report.audio !== 'string' || !report.audio ||
      !Number.isFinite(report.maxVolumeDB) || report.maxVolumeDB < -60 || report.distinctFrames < 2) {
      throw new Error('Smoke report did not verify moving video and audible audio');
    }
    if (typeof report.file !== 'string' || !path.isAbsolute(report.file) ||
      !path.resolve(report.file).startsWith(`${this.smokeDirectory}${path.sep}`) || path.extname(report.file) !== '.mp4') {
      throw new Error('Smoke report has an invalid recording path');
    }
    const media = statSync(report.file);
    if (!media.isFile() || media.size !== report.bytes) throw new Error('Smoke report recording is missing or has the wrong size');
    // Store only the known result fields, never an arbitrary report payload.
    return Object.fromEntries(['jobId', 'startedAt', 'verifiedAt', 'file', 'duration', 'bytes', 'video', 'audio',
      'frames', 'audioFrames', 'maxVolumeDB', 'distinctFrames'].map((key) => [key, report[key]]));
  }

  finish(active, code, signal) {
    if (this.active !== active || active.finishing) return;
    active.finishing = true;
    clearTimeout(active.timer); clearTimeout(active.killTimer); clearTimeout(active.settleTimer);
    const job = active.job;
    Object.assign(job, { finishedAt: new Date().toISOString(), exitCode: code ?? null, signal: signal ?? null });
    if (active.reason) Object.assign(job, active.reason);
    else if (code !== 0 || signal) Object.assign(job, { state: 'failed', error: `Smoke process exited with ${signal || code}` });
    else {
      try { job.report = this.readReport(job); job.state = 'passed'; }
      catch (error) { job.state = 'failed'; job.error = message(error); }
    }
    try { this.save(job); } catch (error) { job.persistenceError = message(error); }
    this.active = null;
    active.resolve(copy(job));
    this.changed(job);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    const active = this.active;
    this.shutdownPromise = active ? active.done.then(() => undefined) : Promise.resolve();
    if (active) this.terminate(active, 'cancelled', 'Recording test cancelled during service shutdown');
    return this.shutdownPromise;
  }

  changed(job) {
    // An observer cannot break the reservation or process cleanup.
    try { this.onChange(copy(job))?.catch?.(() => {}); } catch {}
  }

  save(job) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${job.id}.json`);
    const temp = `${filename}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
      renameSync(temp, filename);
    } finally { try { unlinkSync(temp); } catch {} }
  }

  restore() {
    let files;
    try { files = readdirSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of files) {
      if (!name.endsWith('.json') || !identifier.test(name.slice(0, -5))) continue;
      try {
        const filename = path.join(this.directory, name);
        if (statSync(filename).size > 256 * 1024) continue;
        const job = JSON.parse(readFileSync(filename, 'utf8'));
        if (job.id !== name.slice(0, -5) || !STATES.has(job.state) || !Number.isFinite(Date.parse(job.startedAt))) continue;
        job.logs = String(job.logs ?? '').slice(-MAX_LOG_LENGTH);
        if (job.state === 'running') {
          Object.assign(job, { state: 'failed', finishedAt: new Date().toISOString(), report: null,
            error: 'Service restarted before this recording test completed' });
          this.save(job);
        }
        this.jobs.push(job);
      } catch { /* A damaged job must not prevent service startup. */ }
    }
    this.jobs.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
    this.prune();
  }

  prune() {
    for (const job of this.jobs.splice(MAX_JOBS)) {
      try { unlinkSync(path.join(this.directory, `${job.id}.json`)); } catch {}
    }
  }
}
