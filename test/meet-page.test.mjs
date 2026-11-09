import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { meetPage, MeetPage } from '../src/meet-page.mjs';

function fixture({ labels = [], body = '', name = null, hostname = 'meet.google.com', href = `https://${hostname}/aaa-bbbb-ccc`, namedLabels = {}, cameraNotice = false, lateCameraNotice = false, media = [] } = {}) {
  const events = [];
  let observerCallback;
  class Input {
    constructor() { this.current = name; this.placeholder = 'Your name'; }
    set value(value) { this.current = value; }
    get value() { return this.current; }
    getClientRects() { return [1]; }
    getAttribute() { return null; }
    dispatchEvent(event) { events.push(event.type); }
  }
  const input = name === null ? null : new Input();
  const buttons = labels.map((data) => {
    const item = typeof data === 'string' ? { label: data } : data;
    return { disabled: item.disabled, clicks: 0,
      getClientRects: () => item.hidden ? [] : [1],
      getAttribute: (key) => key === 'aria-label' ? item.label : key === 'aria-disabled' ? String(!!item.ariaDisabled) : key === 'aria-labelledby' ? item.labelledBy ?? null : null,
      innerText: item.text ?? item.label,
      click() { this.clicks++; } };
  });
  const noticeButton = { clicks: 0, getClientRects: () => [1], getAttribute: () => null,
    innerText: 'Got it', click() { this.clicks++; notice.hidden = true; } };
  const notice = { hidden: lateCameraNotice, innerText: 'Others may see your video differently\nGot it',
    getClientRects: () => notice.hidden ? [] : [1],
    querySelectorAll: () => [noticeButton] };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { constructor(callback) { observerCallback = callback; } observe() {} },
    getComputedStyle: () => ({ visibility: 'visible' }), location: { hostname, href },
    document: { title: 'Meet', body: { innerText: body }, documentElement: {},
      getElementById: (id) => id in namedLabels ? { textContent: namedLabels[id] } : null,
      querySelectorAll: (selector) => selector === 'audio,video' ? media : selector === 'input' ? (input ? [input] : []) : selector.includes('dialog') ? (cameraNotice ? [notice] : []) : selector.includes('button') ? buttons : [] },
  });
  return { buttons, noticeButton, input, events,
    revealNotice: () => { notice.hidden = false; observerCallback?.(); },
    run: (op = 'snapshot', value = '') => JSON.parse(JSON.stringify(vm.runInContext(`(${meetPage})(${JSON.stringify(op)},${JSON.stringify(value)})`, context))),
    runAsync: async (op) => JSON.parse(JSON.stringify(await vm.runInContext(`(${meetPage})(${JSON.stringify(op)})`, context))) };
}
test('join and playback recovery activate the page, while snapshots stay read-only', async () => {
  const options = [];
  const page = new MeetPage({ evaluate: async (_expression, config) => { options.push(config); return true; } });
  await page.run('join'); await page.run('resumeAudio'); await page.snapshot();
  assert.deepEqual(options.map(item => item.userGesture), [true, true, false]);
});
test('audio recovery resumes incoming audio without unmuting self-view or unrelated media', async () => {
  const remote = { paused: true, muted: false, volume: 1, plays: 0,
    srcObject: { getAudioTracks: () => [{ readyState: 'live', enabled: true }] },
    play() { this.plays++; this.paused = false; return Promise.resolve(); } };
  const self = { ...remote, muted: true, plays: 0 };
  const unrelated = { ...remote, srcObject: null, plays: 0 };
  const page = fixture({ media: [remote, self, unrelated] });
  assert.deepEqual(await page.runAsync('resumeAudio'), { streams: 2, paused: 0, muted: 1, errors: [] });
  assert.equal(remote.plays, 1); assert.equal(self.plays, 0); assert.equal(unrelated.plays, 0);
  assert.equal(self.muted, true);
});
test('blocked incoming audio returns a warning without rejecting the meeting operation', async () => {
  const remote = { paused: true, muted: false, volume: 1,
    srcObject: { getAudioTracks: () => [{ readyState: 'live', enabled: true }] },
    play: () => Promise.reject(Object.assign(new Error('Blocked'), { name: 'NotAllowedError' })) };
  assert.deepEqual(await fixture({ media: [remote] }).runAsync('resumeAudio'),
    { streams: 1, paused: 1, muted: 0, errors: ['NotAllowedError'] });
});
test('fills Yumi through the native setter and dispatches input events', () => {
  const page = fixture({ labels: ['Ask to join'], name: '' });
  assert.equal(page.run('name', 'Yumi'), true);
  assert.equal(page.run().name, 'Yumi');
  assert.deepEqual(page.events, ['input', 'change']);
});
test('hidden and disabled controls cannot join or prove admission', () => {
  const page = fixture({ labels: [{ label: 'Leave call', hidden: true }, { label: 'Join now', ariaDisabled: true }] });
  assert.equal(page.run().phase, 'loading');
  assert.equal(page.run('join'), false);
  assert.deepEqual(page.buttons.map((button) => button.clicks), [0, 0]);
});
test('visible leave button outweighs quoted chat text', () => {
  const page = fixture({ labels: ['Leave call', 'Turn off microphone (⌘ D)', 'Turn on camera'], body: 'The meeting ended. Ask to join.' });
  assert.equal(page.run().phase, 'in_call');
  assert.equal(page.run().microphone, 'on');
  assert.equal(page.run().camera, 'off');
});
test('waiting, Chinese labels, login and blocked devices', () => {
  assert.equal(fixture({ body: 'Asking to be let in...' }).run().phase, 'waiting_approval');
  assert.equal(fixture({ labels: ['要求加入'] }).run().phase, 'prejoin');
  assert.equal(fixture({ hostname: 'accounts.google.com' }).run().phase, 'needs_login');
  const page = fixture({ labels: ['Camera problem. Show more info', 'Microphone problem. Show more info'] });
  assert.equal(page.run().camera, 'blocked');
  assert.equal(page.run().microphone, 'blocked');
});
test('marketing redirects and optional sign-in links are not login requirements', () => {
  assert.equal(fixture({ hostname: '', href: 'about:blank' }).run().phase, 'loading');
  assert.equal(fixture({ hostname: 'workspace.google.com', body: '登录 Google Meet 立即加入会议' }).run().phase, 'redirected');
  assert.equal(fixture({ body: 'Sign in to Google Meet' }).run().phase, 'loading');
  assert.equal(fixture({ body: 'Sign in to join this meeting' }).run().phase, 'needs_login');
});
test('People badge counts attendees and prevents chat text from ending a live call', () => {
  const three = fixture({ labels: [{ label: null, text: '3', labelledBy: 'people-label' }], namedLabels: { 'people-label': 'People' }, body: "Someone quoted: you're the only one here" });
  assert.equal(three.run().participantCount, 3);
  assert.equal(three.run().alone, false);
  const one = fixture({ labels: [{ label: null, text: '1', labelledBy: 'people-label' }], namedLabels: { 'people-label': 'People' } });
  assert.equal(one.run().participantCount, 1);
  assert.equal(one.run().alone, true);
});
test('dismisses only the camera notice and not an unrelated Got it button', () => {
  const page = fixture({ labels: ['Got it'], cameraNotice: true });
  assert.equal(page.run('dismissCameraNotice'), true);
  assert.equal(page.noticeButton.clicks, 1);
  assert.equal(page.buttons[0].clicks, 0);
  assert.equal(page.run('dismissCameraNotice'), false);
  assert.equal(fixture({ labels: ['Got it'] }).run('dismissCameraNotice'), false);
});
test('dismisses a camera notice inserted after the camera is enabled', () => {
  const page = fixture({ cameraNotice: true, lateCameraNotice: true });
  assert.equal(page.run('dismissCameraNotice'), false);
  page.revealNotice();
  assert.equal(page.noticeButton.clicks, 0);
  assert.equal(page.run('dismissCameraNotice'), true);
  assert.equal(page.noticeButton.clicks, 1);
});
