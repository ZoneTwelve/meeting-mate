import test from 'node:test';
import assert from 'node:assert/strict';
import { meetUrl, normalizeConfig } from '../src/config.mjs';
import { launchdPlist } from '../scripts/launchd.mjs';

const url = 'https://meet.google.com/aaa-bbbb-ccc';
test('guest name, deduplicated URLs and local paths', () => {
  const config = normalizeConfig({ meetingUrls: [url, `${url}/`, 'https://meet.google.com/meet/aaa-bbbb-ccc'] }, { MEET_USERNAME: ' Yumi ' }, '/tmp/meeting-mate');
  assert.equal(config.username, 'Yumi');
  assert.deepEqual(config.meetingUrls, [url]);
  assert.equal(config.pollIntervalMs, 3600000);
  assert.equal(config.recorderApp, '/tmp/meeting-mate/.meeting-mate/Meeting Mate Recorder.app');
});
test('only genuine Google Meet URLs are accepted', () => {
  for (const value of ['http://meet.google.com/aaa-bbbb-ccc', 'https://meet.google.com.evil.test/aaa-bbbb-ccc', 'https://name:secret@meet.google.com/aaa-bbbb-ccc', 'https://meet.google.com/', `${url}/extra`, 'https://meet.google.com:9000/aaa-bbbb-ccc']) {
    assert.throws(() => meetUrl(value));
  }
});
test('invalid names, ports and intervals fail early', () => {
  const raw = { meetingUrls: [url] };
  assert.throws(() => normalizeConfig(raw, {}), /MEET_USERNAME/);
  for (const extra of [{ cdpPort: 1.5 }, { healthPort: 99999 }, { pollIntervalSeconds: 0 }, { segmentSeconds: 1 }, { meetingUrls: [] }]) {
    assert.throws(() => normalizeConfig({ ...raw, ...extra }, { MEET_USERNAME: 'Yumi' }));
  }
});
test('launchd XML escapes paths and waits for graceful finalization', () => {
  const text = launchdPlist('/tmp/A&B <test>', '/tmp/a"b/node', '/usr/bin');
  assert.match(text, /A&amp;B &lt;test&gt;/);
  assert.match(text, /a&quot;b/);
  assert.match(text, /ExitTimeOut<\/key><integer>30/);
});
