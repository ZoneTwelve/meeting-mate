import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { meetPage } from '../src/meet-page.mjs';

function fixture({ labels = [], body = '', name = null, hostname = 'meet.google.com', namedLabels = {}, cameraNotice = false, lateCameraNotice = false } = {}) {
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
    HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { constructor(callback) { observerCallback = callback; } observe() {} },
    getComputedStyle: () => ({ visibility: 'visible' }), location: { hostname, href: `https://${hostname}/aaa-bbbb-ccc` },
    document: { title: 'Meet', body: { innerText: body }, documentElement: {},
      getElementById: (id) => id in namedLabels ? { textContent: namedLabels[id] } : null,
      querySelectorAll: (selector) => selector === 'input' ? (input ? [input] : []) : selector.includes('dialog') ? (cameraNotice ? [notice] : []) : selector.includes('button') ? buttons : [] },
  });
  return { buttons, noticeButton, input, events,
    revealNotice: () => { notice.hidden = false; observerCallback?.(); },
    run: (op = 'snapshot', value = '') => JSON.parse(JSON.stringify(vm.runInContext(`(${meetPage})(${JSON.stringify(op)},${JSON.stringify(value)})`, context))) };
}
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
  assert.equal(page.noticeButton.clicks, 1);
});
