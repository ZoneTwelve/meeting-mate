import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.mjs';
import { normalizeConfig } from '../src/config.mjs';

const url = 'https://meet.google.com/aaa-bbbb-ccc';
function fixture({ extra = {}, phase = 'prejoin', allowed = true, cameraReady = true, multiple = false } = {}) {
  let now = 1000;
  const calls = [];
  const snapshot = { phase, hasNameInput: true, name: '', microphone: 'off', camera: 'off', alone: false };
  const page = {
    snapshot: async () => ({ ...snapshot }),
    prepare: async (name) => { calls.push(['name', name]); snapshot.name = name; return { ...snapshot }; },
    run: async (operation) => {
      calls.push(operation);
      if (operation === 'cameraOn') snapshot.camera = 'on';
      if (operation === 'cameraOff') snapshot.camera = 'off';
      return true;
    },
    cdp: { send: async (method) => calls.push(method) },
  };
  const browser = { pid: 1234, cameraReady, page: async () => page, release: async (url) => calls.push(['release', url]) };
  const config = normalizeConfig({ meetingUrls: multiple ? [url, 'https://meet.google.com/ddd-eeee-fff'] : [url], ...extra }, { MEET_USERNAME: 'Yumi' });
  const recorders = [];
  const monitor = new Monitor(config, browser, { now: () => now, canRecord: async () => allowed, log: () => {},
    createRecorder: () => {
      const recorder = { file: '/tmp/test.mp4', start: async () => calls.push('start'),
        stop: async () => { calls.push('stop'); return { file: recorder.file }; }, health: () => {} };
      recorders.push(recorder); return recorder;
    } });
  return { monitor, calls, snapshot, recorders, advance: (ms) => { now += ms; }, allow: () => { allowed = true; } };
}
test('fills Yumi and asks once, but never records before admission', async () => {
  const f = fixture();
  await f.monitor.tick();
  assert.deepEqual(f.calls, [['name', 'Yumi'], 'join']);
  await f.monitor.tick();
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
  f.snapshot.phase = 'waiting_approval';
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'waiting_approval');
  assert.equal(f.recorders.length, 0);
});
test('recording starts only in-call, before enabling the synthetic camera', async () => {
  const f = fixture({ phase: 'in_call' });
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording');
  assert.ok(f.calls.indexOf('start') < f.calls.indexOf('cameraOn'));
  assert.ok(f.calls.indexOf('cameraOn') < f.calls.indexOf('dismissCameraNotice'));
  assert.match(f.monitor.jobs[0].detail, /camera enabled/);
});
test('no physical camera fallback in an existing unconfigured Chrome', async () => {
  const f = fixture({ phase: 'in_call', cameraReady: false });
  await f.monitor.tick();
  assert.ok(f.calls.includes('start'));
  assert.ok(!f.calls.includes('cameraOn'));
  assert.match(f.monitor.jobs[0].detail, /needs Chrome restart/);
});
test('permission denial preserves the call and throttles retries', async () => {
  const f = fixture({ phase: 'in_call', allowed: false });
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'needs_screen_permission');
  assert.equal(f.recorders.length, 0);
  f.allow();
  f.advance(10000);
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording');
});
test('meeting end finalizes the recording before closing the tab', async () => {
  const f = fixture({ phase: 'in_call' });
  await f.monitor.tick();
  f.snapshot.phase = 'ended';
  await f.monitor.tick();
  assert.ok(f.calls.indexOf('stop') < f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'release'));
  assert.equal(f.monitor.jobs[0].lastRecording.file, '/tmp/test.mp4');
  assert.equal(f.monitor.owner, null);
});
test('recorder startup failure keeps an admitted participant in the call', async () => {
  const f = fixture({ phase: 'in_call' });
  f.monitor.createRecorder = () => ({ file: '/tmp/failed.mp4', start: async () => { throw new Error('Native window not found'); }, stop: async () => null });
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording_error');
  assert.equal(f.monitor.owner, url);
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[0] === 'release'));
  f.advance(15000);
  f.monitor.createRecorder = () => ({ file: '/tmp/retry.mp4', start: async () => f.calls.push('start'), stop: async () => null, health: () => {} });
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording');
});
test('unready prejoin controls keep the request page open for retry', async () => {
  const f = fixture();
  const page = await f.monitor.browser.page(url);
  page.prepare = async () => { throw new Error('Cannot verify microphone/camera are off before joining'); };
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'page_error');
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[0] === 'release'));
});
test('login and unknown pages stop capture, never silently keep recording', async () => {
  for (const phase of ['needs_login', 'loading']) {
    const f = fixture({ phase: 'in_call' });
    await f.monitor.tick();
    f.snapshot.phase = phase;
    await f.monitor.tick();
    assert.ok(f.calls.includes('stop'));
    assert.equal(f.monitor.jobs[0].recorder, null);
  }
});
test('only one meeting can request admission at a time', async () => {
  const f = fixture({ multiple: true });
  await f.monitor.tick();
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
  assert.equal(f.monitor.jobs[1].state, 'capacity_wait');
});
test('host admission timeout releases the slot for the next meeting', async () => {
  const f = fixture({ multiple: true, extra: { joinWaitSeconds: 5 } });
  await f.monitor.tick();
  f.advance(6000);
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'admission_timeout');
  assert.equal(f.monitor.jobs[1].state, 'joining');
});
test('segments finalize and restart without leaving the call', async () => {
  const f = fixture({ phase: 'in_call', extra: { segmentSeconds: 10 } });
  await f.monitor.tick();
  f.advance(11000);
  await f.monitor.tick();
  assert.equal(f.recorders.length, 2);
  assert.ok(f.calls.includes('stop'));
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[0] === 'release'));
});
test('an empty meeting does not create a recording and is left after 30 seconds', async () => {
  const f = fixture({ phase: 'in_call' });
  f.snapshot.alone = true;
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'joined_empty');
  f.advance(31000);
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'empty');
  assert.equal(f.recorders.length, 0);
});
test('hourly checks are measured from each attempt, not from recording end', async () => {
  const f = fixture({ phase: 'in_call' });
  await f.monitor.tick();
  f.advance(600000);
  f.snapshot.phase = 'ended';
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].nextCheckAt, 3601000);
});
test('manual trigger bypasses the hourly check and asks to join immediately', async () => {
  const f = fixture();
  f.monitor.jobs[0].nextCheckAt = 3600000;
  assert.equal(f.monitor.requestJoin(url).status, 'queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'joining');
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
  assert.equal(f.monitor.requestJoin(url).status, 'already_active');
  await f.monitor.tick();
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
});
test('an explicit join reopens a stale login page instead of rejecting forever', async () => {
  const f = fixture({ phase: 'needs_login' });
  await f.monitor.tick(); assert.equal(f.monitor.jobs[0].state, 'needs_login');
  const release = f.monitor.browser.release;
  f.monitor.browser.release = async value => { await release(value); f.snapshot.phase = 'prejoin'; };
  f.advance(1000);
  assert.equal(f.monitor.requestJoin(url).status, 'queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'joining');
  assert.equal(f.calls.filter(x => x === 'join').length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'release').length, 1);
});
test('a page that became a live call while a fresh join was queued is preserved', async () => {
  const f = fixture({ phase: 'needs_login' });
  await f.monitor.tick(); assert.equal(f.monitor.requestJoin(url).status, 'queued');
  f.snapshot.phase = 'in_call'; await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording');
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'release').length, 0);
});
test('a redirect away from Meet closes the stale page and allows a new explicit join', async () => {
  const f = fixture({ phase: 'redirected' }); await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'redirected'); assert.equal(f.monitor.jobs[0].page, null);
  f.snapshot.phase = 'prejoin'; assert.equal(f.monitor.requestJoin(url).status, 'queued'); await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'joining');
});
test('an ad-hoc Meet link is one-shot and is not polled again after it ends', async () => {
  const f = fixture();
  f.monitor.jobs[0].nextCheckAt = 3600000;
  const extra = 'https://meet.google.com/abc-defg-hij';
  assert.equal(f.monitor.requestJoin(extra).status, 'queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].url, extra);
  assert.equal(f.monitor.jobs[0].oneShot, true);
  f.snapshot.phase = 'ended';
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].nextCheckAt, null);
  const count = f.calls.filter((call) => call === 'join').length;
  f.advance(3600000);
  await f.monitor.tick();
  assert.equal(f.calls.filter((call) => call === 'join').length, count);
  assert.equal(f.monitor.jobs[0].state, 'ended');
  f.snapshot.phase = 'prejoin';
  assert.equal(f.monitor.requestJoin(extra).status, 'queued');
  await f.monitor.tick();
  assert.equal(f.calls.filter((call) => call === 'join').length, count + 1);
});
test('manual trigger never displaces another meeting or sends a duplicate request', async () => {
  const f = fixture({ multiple: true });
  assert.equal(f.monitor.requestJoin(url).status, 'queued');
  assert.equal(f.monitor.requestJoin('https://meet.google.com/ddd-eeee-fff').status, 'busy');
  await f.monitor.tick();
  assert.equal(f.monitor.requestJoin('https://meet.google.com/ddd-eeee-fff').status, 'busy');
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
});
test('manual request arriving during another page preparation takes priority', async () => {
  const f = fixture({ multiple: true });
  const first = await f.monitor.browser.page(url);
  first.prepare = async (name) => {
    f.snapshot.name = name;
    assert.equal(f.monitor.requestJoin('https://meet.google.com/ddd-eeee-fff').status, 'queued');
    return { ...f.snapshot };
  };
  await f.monitor.tick();
  assert.equal(f.monitor.owner, 'https://meet.google.com/ddd-eeee-fff');
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].url, 'https://meet.google.com/ddd-eeee-fff');
  assert.equal(f.calls.filter((call) => call === 'join').length, 1);
});
test('pause finalizes a segment and resume keeps the same call and session', async () => {
  const f = fixture({ phase: 'in_call' });
  await f.monitor.tick();
  const sessionId = f.monitor.jobs[0].sessionId;
  assert.equal(f.monitor.requestControl('pause').status, 'pause_queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'paused');
  assert.equal(f.monitor.jobs[0].recorder, null);
  assert.equal(f.snapshot.camera, 'off');
  assert.equal(f.monitor.owner, url);
  await f.monitor.tick();
  assert.equal(f.recorders.length, 1);
  assert.equal(f.monitor.requestControl('resume').status, 'resume_queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'recording');
  assert.equal(f.recorders.length, 2);
  assert.equal(f.monitor.jobs[0].sessionId, sessionId);
  assert.equal(f.monitor.jobs[0].segmentIndex, 2);
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[0] === 'release'));
});
test('stop finalizes, closes the call and delays the next automatic check', async () => {
  const f = fixture({ phase: 'in_call' });
  await f.monitor.tick();
  f.advance(3600000);
  assert.equal(f.monitor.requestControl('stop').status, 'stop_queued');
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'stopped');
  assert.equal(f.monitor.jobs[0].nextCheckAt, 7201000);
  assert.equal(f.monitor.isBusy(), false);
  assert.ok(f.calls.indexOf('stop') < f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'release'));
  f.advance(1000);
  assert.equal(f.monitor.requestControl('stop', url).status, 'already_stopped');
  assert.equal(f.monitor.jobs[0].nextCheckAt, 7201000);
});
test('stop cancels a queued join before it opens a page', async () => {
  const f = fixture();
  f.monitor.requestJoin(url);
  assert.equal(f.monitor.isBusy(), true);
  f.monitor.requestControl('stop');
  await f.monitor.tick();
  assert.equal(f.monitor.isBusy(), false);
  assert.equal(f.calls.length, 0);
});
test('stop arriving during preparation prevents an admission request', async () => {
  const f = fixture();
  const page = await f.monitor.browser.page(url);
  page.prepare = async (name) => {
    f.snapshot.name = name;
    assert.equal(f.monitor.requestControl('stop', url).status, 'stop_queued');
    return { ...f.snapshot };
  };
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'stopped');
  assert.equal(f.calls.includes('join'), false);
});
test('stop or pause during segment finalization cannot start another segment', async () => {
  for (const action of ['stop', 'pause']) {
    const f = fixture({ phase: 'in_call', extra: { segmentSeconds: 10 } });
    await f.monitor.tick();
    f.recorders[0].stop = async () => {
      assert.equal(f.monitor.isBusy(), true);
      f.monitor.requestControl(action);
      return { file: '/tmp/test.mp4' };
    };
    f.advance(11000);
    await f.monitor.tick();
    assert.equal(f.recorders.length, 1);
    await f.monitor.tick();
    assert.equal(f.monitor.jobs[0].state, action === 'stop' ? 'stopped' : 'paused');
  }
});
test('a stop during permission inspection cannot start capture', async () => {
  const f = fixture({ phase: 'in_call' });
  f.monitor.canRecord = async () => { f.monitor.requestControl('stop'); return true; };
  await f.monitor.tick();
  assert.equal(f.recorders.length, 0);
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'stopped');
});
test('only the end of a session enqueues post-processing, never a segment or pause', async () => {
  const f = fixture({ phase: 'in_call', extra: { segmentSeconds: 10 } });
  const sessions = [];
  f.monitor.onSessionFinished = (session) => { sessions.push(session); };
  await f.monitor.tick();
  const sessionId = f.monitor.jobs[0].sessionId;
  f.advance(11000);
  await f.monitor.tick();
  assert.equal(sessions.length, 0);
  f.monitor.requestControl('pause');
  await f.monitor.tick();
  assert.equal(sessions.length, 0);
  f.snapshot.phase = 'ended';
  await f.monitor.tick();
  assert.deepEqual(sessions, [{ sessionId, url }]);
  await f.monitor.tick();
  assert.equal(sessions.length, 1);
});
test('a transcription enqueue failure does not undo recording cleanup', async () => {
  const f = fixture({ phase: 'in_call' });
  f.monitor.onSessionFinished = () => { throw new Error('Queue failure'); };
  await f.monitor.tick();
  f.snapshot.phase = 'ended';
  await f.monitor.tick();
  assert.equal(f.monitor.jobs[0].state, 'ended');
  assert.equal(f.monitor.isBusy(), false);
  assert.equal(f.monitor.jobs[0].lastRecording.file, '/tmp/test.mp4');
});
