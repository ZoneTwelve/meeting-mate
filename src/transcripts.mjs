import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { access, open, statfs } from 'node:fs/promises';
import path from 'node:path';
import { root } from './config.mjs';
import { formatTranscript, validateTranscript } from './transcript-format.mjs';

const idPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const clone = (value) => structuredClone(value);
const limitValue = (limit) => { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problem('limit must be an integer from 1 to 100'); return limit; };
const ENGINE_VERSION = 'local-whisper-sherpa-v2';

export class Transcripts {
  constructor(config, catalog, { isBusy = () => false, isSessionActive = () => false, onChange = () => {}, spawnProcess = spawn,
    rootDir = root, timeoutMs = 4 * 3600000, killTimeoutMs = 5000 } = {}) {
    Object.assign(this, { config, catalog, isBusy, isSessionActive, onChange, spawnProcess, rootDir, timeoutMs, killTimeoutMs });
    this.directory = config.transcriptsDir;
    this.jobs = [];
    this.active = null;
    this.stopping = false;
    this.submissions = Promise.resolve();
    this.restore();
  }
  get running() { return this.active !== null; }
  summary() { return { enabled: this.config.transcriptEnabled, activeJobId: this.active?.job.id ?? null, queued: this.jobs.filter((job) => job.state === 'queued').length }; }
  paths(id) {
    if (!idPattern.test(id)) throw problem('Invalid transcript ID');
    return { job: path.join(this.directory, `${id}.job.json`), input: path.join(this.directory, `${id}.input.json`), output: path.join(this.directory, `${id}.json`) };
  }
  save(job) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.paths(job.id).job;
    const temp = `${filename}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(temp, filename);
  }
  restore() {
    let names;
    try { names = readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!name.endsWith('.job.json') || !idPattern.test(name.slice(0, -9))) continue;
      try {
        const file = path.join(this.directory, name);
        if (statSync(file).size > 2 ** 20) continue;
        const job = JSON.parse(readFileSync(file, 'utf8'));
        if (job.id !== name.slice(0, -9) || !['queued', 'running', 'completed', 'failed'].includes(job.state) || !Array.isArray(job.recordings)) continue;
        if (job.state === 'running') { job.state = 'queued'; job.phase = 'recovered'; job.error = null; this.save(job); }
        this.jobs.push(job);
      } catch { /* Invalid history cannot prevent the recorder from starting. */ }
    }
    this.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  metadata(job) {
    const { recordings, ...data } = job;
    return { ...clone(data), recordings: recordings.map(({ file, ...recording }) => recording),
      downloads: job.state === 'completed' ? Object.fromEntries(['json', 'txt', 'srt', 'vtt'].map((format) => [format, `http://127.0.0.1:${this.config.healthPort}/v1/transcripts/${job.id}/file?format=${format}`])) : null };
  }
  list(limit = 50) { return this.jobs.slice(0, limitValue(limit)).map((job) => this.metadata(job)); }
  async get(id) {
    this.paths(id);
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw problem('Transcript not found', 404);
    return { ...this.metadata(job), result: job.state === 'completed' ? await this.readResult(job) : null };
  }
  async readResult(job) {
    let handle;
    try {
      handle = await open(this.paths(job.id).output, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 20 * 1024 ** 2) throw problem('Transcript result is invalid or too large', 422);
      return validateTranscript(JSON.parse(await handle.readFile('utf8')), job);
    } finally { await handle?.close(); }
  }
  async file(id, format = 'txt') {
    const job = await this.get(id);
    if (job.state !== 'completed') throw problem('Transcript is not complete', 409);
    return { text: formatTranscript(job.result, format), filename: `${id}.${format}`,
      contentType: format === 'json' ? 'application/json' : format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8' };
  }
  create(options) {
    if (this.stopping) return Promise.reject(problem('Transcript service is stopping', 503));
    // Serialize validation + durable reservation, including duplicate HTTP requests.
    const pending = this.submissions.then(() => this.reserve(options));
    this.submissions = pending.catch(() => {});
    return pending;
  }
  enqueueSession(sessionId) {
    if (this.stopping) return Promise.reject(problem('Transcript service is stopping', 503));
    const pending = this.submissions.then(async () => {
      const recordings = await this.catalog.all();
      const recording = recordings.find((item) => item.sessionId === sessionId && item.status === 'verified');
      return recording ? this.reserve({ recordingId: recording.id }) : null;
    });
    this.submissions = pending.catch(() => {});
    return pending;
  }
  async reserve({ recordingId, language = this.config.transcriptLanguage ?? 'auto', numSpeakers = null } = {}) {
    if (!/^(auto|[a-z]{2,3})$/.test(language) || typeof language !== 'string') throw problem('Invalid transcript language');
    if (numSpeakers !== null && (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > 20)) throw problem('numSpeakers must be from 1 to 20');
    const selected = await this.catalog.get(recordingId);
    if (this.isSessionActive(selected.sessionId, selected.meetingUrl)) throw problem('Wait for the meeting to finish before transcribing', 409);
    let recordings = selected.sessionId ? (await this.catalog.all()).filter((item) => item.sessionId === selected.sessionId) : [selected];
    recordings.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    if (!recordings.length || recordings.some((item) => item.status !== 'verified' || !item.available || !(item.duration > 0) || !Number.isFinite(Date.parse(item.startedAt)))) {
      throw problem('All session recordings must be finalized and verified', 409);
    }
    const origin = Date.parse(recordings[0].startedAt);
    recordings = await Promise.all(recordings.map(async (item) => {
      const { handle } = await this.catalog.openFile(item.id);
      try {
        const stat = await handle.stat();
        return { id: item.id, file: item.file, duration: item.duration, startedAt: item.startedAt, endedAt: item.endedAt,
          offsetSeconds: (Date.parse(item.startedAt) - origin) / 1000, bytes: stat.size, modifiedAt: stat.mtimeMs };
      } finally { await handle.close(); }
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify({ engine: ENGINE_VERSION, recordings, language, numSpeakers })).digest('hex');
    const existing = this.jobs.find((job) => job.fingerprint === fingerprint && job.state !== 'failed');
    if (existing) {
      if (existing.state !== 'completed') return this.metadata(existing);
      try { await this.readResult(existing); return this.metadata(existing); }
      catch { existing.state = 'failed'; existing.error = 'Completed transcript output is missing or invalid'; this.save(existing); }
    }
    if (this.jobs.filter((job) => job.state === 'queued').length >= 20) throw problem('Transcript queue is full', 409);
    const job = { id: randomUUID(), fingerprint, sessionId: selected.sessionId, meetingUrl: selected.meetingUrl,
      state: 'queued', phase: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      language, numSpeakers, engineVersion: ENGINE_VERSION, recordings, error: null, logs: '', attempts: 0 };
    this.save(job);
    this.jobs.unshift(job);
    this.changed();
    return this.metadata(job);
  }
  changed() { try { this.onChange(); } catch {} }
  pump() {
    if (this.stopping) return;
    if (this.active) {
      const suspended = this.isBusy();
      if (this.active.child && suspended !== !!this.active.job.suspended) {
        this.signal(this.active, suspended ? 'SIGSTOP' : 'SIGCONT');
        this.active.job.suspended = suspended;
        this.changed();
      }
      return;
    }
    if (this.isBusy()) return;
    const job = [...this.jobs].reverse().find((item) => item.state === 'queued');
    if (!job) return;
    const active = { job, child: null, finishing: false };
    active.done = new Promise((resolve) => { active.resolve = resolve; });
    this.active = active;
    this.launch(active).catch((error) => this.finish(active, error));
  }
  async launch(active) {
    const { job } = active;
    await access(this.config.transcriptPython).catch(() => { throw new Error('Local transcript environment is missing; run pnpm run transcript:setup'); });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const disk = await statfs(this.directory);
    const extractedBytes = job.recordings.reduce((sum, recording) => sum + recording.duration * 16000 * 4, 0);
    if (disk.bavail * disk.bsize < this.config.minFreeBytes + extractedBytes) throw new Error('Insufficient free disk space for transcript audio extraction');
    for (const recording of job.recordings) {
      const { handle, recording: current } = await this.catalog.openFile(recording.id);
      try {
        const stat = await handle.stat();
        if (current.file !== recording.file || stat.size !== recording.bytes || stat.mtimeMs !== recording.modifiedAt) throw new Error('Recording changed after transcript was queued; submit a new job');
      } finally { await handle.close(); }
    }
    if (this.stopping) { this.active = null; active.resolve(); return; }
    if (this.isBusy()) { this.active = null; active.resolve(); return; }
    const files = this.paths(job.id);
    writeFileSync(files.input, JSON.stringify({ jobId: job.id, language: job.language, numSpeakers: job.numSpeakers, recordings: job.recordings }), { mode: 0o600 });
    Object.assign(job, { state: 'running', phase: 'starting', startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
    this.save(job);
    const child = active.child = this.spawnProcess(this.config.transcriptPython, [path.join(this.rootDir, 'scripts/transcribe.py'),
      '--manifest', files.input, '--output', files.output, '--models', this.config.transcriptModels], {
      cwd: this.rootDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', OMP_NUM_THREADS: '2', PYTHONUNBUFFERED: '1' },
    });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending = (pending + chunk.toString()).slice(-16384);
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (typeof event.phase === 'string') job.phase = event.phase.slice(0, 80);
          if (Number.isFinite(event.progress)) job.progress = Math.max(0, Math.min(100, event.progress));
          this.changed();
        } catch { /* Worker diagnostics do not become instructions or state. */ }
      }
    });
    child.stderr.on('data', (chunk) => { job.logs = (job.logs + chunk.toString()).slice(-8192); });
    child.once('error', (error) => {
      if (child.pid) { active.error = error; this.terminate(active); }
      else this.finish(active, error);
    });
    child.once('close', (code, signal) => this.finish(active, active.error ?? (code !== 0 || signal ? new Error(`Transcript worker exited: ${signal ?? code}. ${job.logs.slice(-2000)}`) : null)));
    active.timer = setTimeout(() => { active.error = new Error('Transcript processing timed out'); this.terminate(active); }, this.timeoutMs);
    this.changed();
  }
  terminate(active) {
    if (!active.child || active.finishing) return;
    if (active.job.suspended) { this.signal(active, 'SIGCONT'); active.job.suspended = false; }
    this.signal(active, 'SIGTERM');
    clearTimeout(active.killTimer);
    active.killTimer = setTimeout(() => {
      this.signal(active, 'SIGKILL');
      active.settleTimer = setTimeout(() => this.finish(active, active.error ?? new Error('Transcript worker did not exit after termination')), 1000);
    }, this.killTimeoutMs);
  }
  signal(active, name) {
    // A detached worker owns its own process group, including local FFmpeg.
    try { if (active.child.pid) process.kill(-active.child.pid, name); else active.child.kill(name); }
    catch { try { active.child.kill(name); } catch {} }
  }
  async finish(active, error) {
    if (this.active !== active || active.finishing) return;
    active.finishing = true;
    clearTimeout(active.timer); clearTimeout(active.killTimer); clearTimeout(active.settleTimer);
    const { job } = active;
    try {
      if (active.interrupted) { job.state = 'queued'; job.phase = 'interrupted'; }
      else {
        if (error) throw error;
        const result = await this.readResult(job);
        for (const format of ['txt', 'srt', 'vtt']) writeFileSync(path.join(this.directory, `${job.id}.${format}`), formatTranscript(result, format), { mode: 0o600 });
        Object.assign(job, { state: 'completed', phase: 'completed', progress: 100, finishedAt: new Date().toISOString(), error: null });
      }
    } catch (failure) { Object.assign(job, { state: 'failed', phase: 'failed', finishedAt: new Date().toISOString(), error: String(failure.message).slice(-4096) }); }
    try { this.save(job); } catch (failure) { job.persistenceError = failure.message; }
    this.active = null;
    active.resolve();
    this.changed();
  }
  async shutdown() {
    this.stopping = true;
    await this.submissions;
    const active = this.active;
    if (!active) return;
    active.interrupted = true;
    this.terminate(active);
    await active.done;
  }
}
