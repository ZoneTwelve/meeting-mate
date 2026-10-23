import { Recorder, permission } from './recorder.mjs';
import { meetUrl } from './config.mjs';
import { randomUUID } from 'node:crypto';

export class Monitor {
  constructor(config, browser, { createRecorder = () => new Recorder(config), canRecord = () => permission(config), now = Date.now, log = console.log, onSessionFinished = () => {} } = {}) {
    this.config = config;
    this.browser = browser;
    this.createRecorder = createRecorder;
    this.canRecord = canRecord;
    this.now = now;
    this.log = log;
    this.onSessionFinished = onSessionFinished;
    this.jobs = config.meetingUrls.map((url) => ({ url, state: 'scheduled', nextCheckAt: 0 }));
    this.owner = null;
    this.stopping = false;
    this.pendingJoin = null;
    this.ticking = false;
  }
  isBusy() {
    return this.ticking || !!this.pendingJoin || !!this.owner || this.jobs.some((job) => job.page || job.recorder || job.pendingAttempt || job.joinInFlight);
  }
  requestControl(action, value) {
    if (!['stop', 'pause', 'resume'].includes(action)) throw new Error('Unknown meeting action');
    const url = value ? meetUrl(value) : this.owner ?? this.pendingJoin ?? this.jobs.find((job) => job.page || job.recorder || job.stepping)?.url;
    if (this.stopping) return { accepted: false, status: 'stopping', url };
    if (!url) return { accepted: action === 'stop', status: action === 'stop' ? 'already_stopped' : 'not_in_call' };
    const job = this.jobs.find((item) => item.url === url);
    if (action === 'stop') {
      if (this.pendingJoin === url) this.pendingJoin = null;
      if (!job) return { accepted: true, status: 'already_stopped', url };
      job.pendingAttempt = false;
      if (!job.page && !job.recorder && !job.joinInFlight && !job.stepping) {
        if (job.state === 'stopped') return { accepted: true, status: 'already_stopped', url };
        job.nextCheckAt = job.oneShot ? null : this.now() + this.config.pollIntervalMs;
        this.set(job, 'stopped', 'Stopped by local control');
        return { accepted: true, status: 'already_stopped', url };
      }
      job.stopRequested = true;
      job.controlStopUntil = this.now() + this.config.pollIntervalMs;
      return { accepted: true, status: 'stop_queued', url };
    }
    if (!job?.joinedAt || job.stopRequested) return { accepted: false, status: 'not_in_call', url };
    const paused = action === 'pause';
    if (!!job.paused === paused) return { accepted: true, status: paused ? (job.state === 'paused' ? 'already_paused' : 'pause_queued') : (job.state === 'paused' ? 'resume_queued' : 'already_resumed'), url };
    job.paused = paused;
    if (!paused) job.recordRetryAt = 0;
    return { accepted: true, status: `${action}_queued`, url };
  }
  requestJoin(value) {
    const url = meetUrl(value);
    if (this.stopping) return { accepted: false, status: 'stopping', url };
    const active = this.jobs.find((job) => job.url !== url &&
      (job.joinRequestedAt || job.joinedAt || job.joinInFlight || job.recorder));
    const busyUrl = active?.url ?? (this.owner !== url ? this.owner : null) ??
      (this.pendingJoin !== url ? this.pendingJoin : null);
    if (busyUrl) return { accepted: false, status: 'busy', url, activeUrl: busyUrl };
    const job = this.jobs.find((item) => item.url === url);
    if (job?.stopRequested) return { accepted: false, status: 'busy', url, activeUrl: url };
    if (job && (job.joinRequestedAt || job.joinedAt || job.joinInFlight)) {
      return { accepted: true, status: 'already_active', url, state: job.state };
    }
    if (job) job.refreshRequested = true;
    this.pendingJoin = url;
    return { accepted: true, status: 'queued', url };
  }
  activatePendingJoin() {
    if (!this.pendingJoin) return;
    const url = this.pendingJoin;
    this.pendingJoin = null;
    let job = this.jobs.find((item) => item.url === url);
    if (!job) {
      job = { url, state: 'scheduled', nextCheckAt: 0, oneShot: true };
      this.jobs.unshift(job);
    } else {
      this.jobs = [job, ...this.jobs.filter((item) => item !== job)];
    }
    job.pendingAttempt = true;
    job.nextCheckAt = 0;
    job.pageRetryAt = 0;
  }
  set(job, state, detail = '') {
    if (job.state !== state || job.detail !== detail) {
      this.log(JSON.stringify({ at: new Date(this.now()).toISOString(), meeting: job.url, state, detail }));
    }
    job.state = state; job.detail = detail; job.updatedAt = new Date(this.now()).toISOString();
  }
  summary() {
    return this.jobs.map(({ page, recorder, ...job }) => ({ ...job, recordingFile: recorder?.file ?? null }));
  }
  async stopRecording(job) {
    if (!job.recorder) return;
    const recorder = job.recorder;
    job.recorder = null;
    // Remove the indicator as soon as recording is no longer active.
    await job.page?.run('cameraOff').catch(() => {});
    const media = await recorder.stop();
    if (media) job.lastRecording = media;
  }
  async finish(job, state, detail = '') {
    const endedSession = job.joinedAt && job.sessionId ? { sessionId: job.sessionId, url: job.url } : null;
    let failure;
    try { await this.stopRecording(job); } catch (error) { failure = error; }
    try { await this.browser.release(job.url); } catch (error) { failure ??= error; }
    job.page = null;
    if (this.owner === job.url) this.owner = null;
    job.joinRequestedAt = null; job.joinedAt = null; job.aloneSince = null;
    job.recordRetryAt = null;
    job.pageRetryAt = null;
    job.pendingAttempt = false;
    job.stopRequested = false;
    job.paused = false;
    job.nextCheckAt = job.oneShot ? null : Math.max((job.attemptAt ?? this.now()) + this.config.pollIntervalMs, this.now() + 30000, job.controlStopUntil ?? 0);
    job.controlStopUntil = null;
    this.set(job, failure ? 'error' : state, failure?.message ?? detail);
    // Post-processing must never keep a Meet tab open or fail recorder cleanup.
    if (endedSession) {
      const failed = (error) => this.log(JSON.stringify({ event: 'transcript_queue_error', sessionId: endedSession.sessionId, error: error.message }));
      try { Promise.resolve(this.onSessionFinished(endedSession)).catch(failed); } catch (error) { failed(error); }
    }
  }
  async tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      this.activatePendingJoin();
      for (const job of this.jobs) {
        if (this.stopping) return;
        job.stepping = true;
        try { await this.step(job); }
        catch (error) {
          // A transient recorder or Meet UI error must not withdraw a join request
          // or eject an already admitted participant.
          let detail = error.message;
          try { await this.stopRecording(job); }
          catch (stopError) { detail += `; finalization: ${stopError.message}`; }
          job.recordRetryAt = this.now() + 15000;
          job.pageRetryAt = this.now() + 5000;
          this.set(job, job.joinedAt ? 'recording_error' : 'page_error', detail);
        } finally { job.stepping = false; }
      }
    } finally { this.ticking = false; }
  }
  async step(job) {
    const now = this.now();
    if (job.stopRequested) { await this.finish(job, 'stopped', 'Stopped by local control'); return; }
    if (job.refreshRequested) {
      job.refreshRequested = false;
      // Re-open stale pages on an explicit join, while preserving a call that
      // became active between receiving the command and this monitor tick.
      if (!job.joinedAt && !job.joinRequestedAt && !job.joinInFlight && !job.recorder) {
        const current = job.page ? await job.page.snapshot() : null;
        if (!['in_call', 'waiting_approval'].includes(current?.phase)) {
          if (job.page) await this.browser.release(job.url);
          job.page = null;
        }
        job.attemptAt = now; job.paused = false;
      }
    }
    if (!job.page) {
      if (job.oneShot && !job.pendingAttempt) return;
      if (now < (job.pageRetryAt ?? 0)) return;
      if (now < job.nextCheckAt) return;
      job.attemptAt = now;
      this.set(job, 'checking');
      job.page = await this.browser.page(job.url);
      job.pendingAttempt = false;
    }
    const snapshot = await job.page.snapshot();
    if (job.stopRequested) { await this.finish(job, 'stopped', 'Stopped by local control'); return; }
    if (snapshot.phase === 'redirected') { await this.finish(job, 'redirected', 'The Meet page navigated away from the meeting'); return; }
    if (snapshot.phase === 'ended') { await this.finish(job, 'ended', 'Meeting ended, access denied, or removed'); return; }
    if (snapshot.phase === 'needs_login') {
      await this.stopRecording(job);
      if (this.owner === job.url) this.owner = null;
      job.joinedAt = null; job.joinRequestedAt = null;
      this.set(job, 'needs_login', 'This meeting requires a Google account; the current page is left untouched');
      return;
    }
    if (snapshot.phase === 'waiting_approval') {
      await this.stopRecording(job);
      job.joinRequestedAt ??= now;
      this.owner ??= job.url;
      if (now - job.joinRequestedAt >= this.config.joinWaitMs) { await this.finish(job, 'admission_timeout'); return; }
      this.set(job, 'waiting_approval', `Waiting for the host to admit ${this.config.username}`);
      return;
    }
    if (snapshot.phase === 'prejoin') {
      if (job.joinedAt) { await this.finish(job, 'disconnected'); return; }
      if (this.owner && this.owner !== job.url) {
        this.set(job, 'capacity_wait', 'Another listed meeting is using the recorder');
        return;
      }
      if (job.joinRequestedAt) {
        if (now - job.joinRequestedAt >= this.config.joinWaitMs) await this.finish(job, 'admission_timeout');
        return; // Do not repeatedly send join requests.
      }
      if (now < (job.pageRetryAt ?? 0)) return;
      const prepared = await job.page.prepare(this.config.username);
      if (prepared.hasNameInput && prepared.name !== this.config.username) throw new Error('Guest name did not match MEET_USERNAME');
      if (job.stopRequested) { await this.finish(job, 'stopped', 'Stopped by local control'); return; }
      // A manual trigger may have arrived while this page was preparing.
      if (this.pendingJoin && this.pendingJoin !== job.url) {
        this.set(job, 'capacity_wait', 'Immediate join requested for another meeting');
        return;
      }
      let requested;
      job.joinInFlight = true;
      try { requested = await job.page.run('join'); }
      finally { job.joinInFlight = false; }
      if (requested) {
        job.joinRequestedAt = now;
        this.owner = job.url;
        job.identityMode = prepared.hasNameInput ? 'guest' : 'google_account';
        this.set(job, 'joining', prepared.hasNameInput ? `Requesting admission as ${this.config.username}` : 'Requesting admission with the signed-in Google account');
      }
      return;
    }
    if (snapshot.phase === 'in_call') {
      if (this.owner && this.owner !== job.url) { await this.finish(job, 'capacity_wait', 'A second simultaneous call cannot share this audio source'); return; }
      this.owner = job.url;
      if (!job.joinedAt) {
        job.joinedAt = now;
        job.sessionId = randomUUID();
        job.segmentIndex = 0;
      }
      if (snapshot.microphone === 'on') await job.page.run('microphoneOff');
      if (now - job.joinedAt >= this.config.maxSessionMs) { await this.finish(job, 'session_limit'); return; }
      if (snapshot.alone) {
        job.aloneSince ??= now;
        if (now - job.aloneSince >= 30000) { await this.finish(job, 'empty', 'No other attendees'); return; }
      } else job.aloneSince = null;
      if (job.paused) {
        await this.stopRecording(job);
        await job.page.run('cameraOff');
        this.set(job, 'paused', 'Recording paused; still in the meeting');
        return;
      }
      if (snapshot.alone && !job.recorder) { this.set(job, 'joined_empty', 'Waiting briefly for another attendee'); return; }
      if (job.recorder && (job.recorder.finished || now - job.segmentAt >= this.config.segmentMs)) await this.stopRecording(job);
      if (job.stopRequested || job.paused) return;
      if (!job.recorder) {
        // Throttle permission/error checks without reloading or leaving the meeting.
        if (now < (job.recordRetryAt ?? 0)) return;
        if (!await this.canRecord()) {
          await job.page.run('cameraOff');
          job.recordRetryAt = now + 10000;
          this.set(job, 'needs_screen_permission', 'Allow Meeting Mate Recorder in macOS Screen & System Audio Recording');
          return;
        }
        if (job.stopRequested || job.paused) return;
        // Meet can immediately reset document.title. Match the stable meeting
        // code in the native Chrome window title instead of our temporary title.
        const title = new URL(job.url).pathname.split('/').at(-1);
        // Ensure this exact tab is the visible content of its own window.
        await job.page.cdp?.send('Page.bringToFront');
        if (job.stopRequested || job.paused) return;
        job.recorder = this.createRecorder();
        this.set(job, 'starting_recording');
        await job.recorder.start({ pid: this.browser.pid, title, url: job.url, sessionId: job.sessionId, segmentIndex: job.segmentIndex + 1 });
        job.segmentIndex++;
        job.segmentAt = this.now();
      }
      if (job.stopRequested || job.paused) return;
      job.recorder.health();
      if (this.config.cameraIndicator && this.browser.cameraReady) {
        if (snapshot.camera !== 'on') await job.page.run('cameraOn');
        // Meet can overlay the video with this one-time self-view notice.
        // Check every tick because the dialog can appear after cameraOn returns.
        await job.page.run('dismissCameraNotice');
        const current = await job.page.snapshot();
        this.set(job, 'recording', current.camera === 'on' ? 'Recording locally; RECORDING camera enabled' : 'Recording locally; camera indicator is unavailable');
      } else {
        if (snapshot.camera === 'on') await job.page.run('cameraOff');
        this.set(job, 'recording', this.config.cameraIndicator ? 'Recording locally; camera indicator needs Chrome restart after this call' : 'Recording locally');
      }
      return;
    }
    // Unknown / disconnected pages are not proof that recording may continue.
    if (job.recorder) await this.stopRecording(job);
    this.set(job, 'loading', 'Waiting for recognizable Meet controls');
    if (now - (job.joinRequestedAt ?? job.attemptAt) > (job.joinRequestedAt ? this.config.joinWaitMs : 60000)) await this.finish(job, 'page_timeout');
  }
  async shutdown() {
    this.stopping = true;
    for (const job of this.jobs) {
      if (!job.page && !job.recorder) continue;
      await this.finish(job, 'stopped');
    }
  }
}
