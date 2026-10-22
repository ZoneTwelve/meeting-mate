import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createControlServer } from '../src/control-server.mjs';

const url = 'https://meet.google.com/aaa-bbbb-ccc';
async function withServer(onJoin, action, services = {}) {
  const server = createControlServer(() => ({ state: 'scheduled', meetings: [] }), onJoin, services);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
test('local join request is validated, queued and reported separately from health', async () => {
  const seen = [];
  await withServer((value) => { seen.push(value); return { accepted: true, status: 'queued', url: value }; }, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal((await health.json()).state, 'scheduled');
    const response = await fetch(`${base}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'queued');
    assert.deepEqual(seen, [url]);
  });
});
test('rejects browser origins, invalid URLs and non-JSON form posts', async () => {
  const seen = [];
  await withServer((value) => { seen.push(value); return { accepted: true, status: 'queued' }; }, async (base) => {
    const post = (body, headers) => fetch(`${base}/join`, { method: 'POST', headers, body });
    assert.equal((await post(JSON.stringify({ url }), { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(`url=${encodeURIComponent(url)}`, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await post(JSON.stringify({ url: 'https://meet.google.com.evil.example/aaa-bbbb-ccc' }), { 'content-type': 'application/json' })).status, 400);
    assert.equal((await post('{', { 'content-type': 'application/json' })).status, 400);
    assert.deepEqual(seen, []);
  });
});
test('reports busy instead of displacing the active meeting', async () => {
  await withServer(() => ({ accepted: false, status: 'busy', activeUrl: url }), async (base) => {
    const response = await fetch(`${base}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://meet.google.com/abc-defg-hij' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).activeUrl, url);
  });
});
test('versioned control routes forward optional current-meeting targets', async () => {
  const seen = [];
  await withServer(() => ({ accepted: true, status: 'queued' }), async (base) => {
    for (const action of ['stop', 'pause', 'resume']) {
      const response = await fetch(`${base}/v1/meetings/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 202);
    }
    assert.deepEqual(seen, [['stop', undefined], ['pause', undefined], ['resume', undefined]]);
    assert.deepEqual(await (await fetch(`${base}/v1/meetings`)).json(), { meetings: [] });
  }, { onControl: (action, value) => { seen.push([action, value]); return { accepted: true, status: `${action}_queued` }; } });
});
test('idempotency keys replay a response and reject a conflicting operation', async () => {
  let calls = 0;
  await withServer(() => { calls++; return { accepted: true, status: 'queued' }; }, async (base) => {
    const post = (link) => fetch(`${base}/v1/meetings/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'one-request' }, body: JSON.stringify({ url: link }) });
    assert.equal((await post(url)).status, 202);
    assert.equal((await post(url)).status, 202);
    assert.equal(calls, 1);
    assert.equal((await post('https://meet.google.com/abc-defg-hij')).status, 409);
  });
});
test('recording test busy result and missing jobs preserve their HTTP semantics', async () => {
  await withServer(() => ({}), async (base) => {
    const response = await fetch(`${base}/v1/recording-tests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 409);
    assert.equal((await fetch(`${base}/v1/recording-tests/latest`)).status, 404);
    const status = await new Promise((resolve, reject) => {
      http.get(`${base}/healthz`, { headers: { host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  }, { recordingTests: { start: () => { throw Object.assign(new Error('Meeting is active'), { statusCode: 409 }); }, get: () => null } });
});
test('transcript routes preserve queued states and async idempotency while serving exports', async () => {
  let resolveJob;
  let called;
  const entered = new Promise((resolve) => { called = resolve; });
  const job = { id: 'example-job', state: 'queued' };
  const pending = new Promise((resolve) => { resolveJob = resolve; });
  let calls = 0;
  await withServer(() => ({}), async (base) => {
    const post = (recordingId) => fetch(`${base}/v1/transcripts`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'transcript-key' }, body: JSON.stringify({ recordingId }) });
    const first = post('source.mp4');
    await entered;
    const duplicate = post('source.mp4');
    assert.equal((await post('different.mp4')).status, 409);
    resolveJob(job);
    assert.equal((await first).status, 202);
    assert.deepEqual(await (await duplicate).json(), job);
    assert.equal(calls, 1);
    assert.deepEqual(await (await fetch(`${base}/v1/transcripts`)).json(), { transcripts: [job] });
    assert.deepEqual(await (await fetch(`${base}/v1/transcripts/example-job`)).json(), job);
    const file = await fetch(`${base}/v1/transcripts/example-job/file?format=txt`);
    assert.equal(await file.text(), 'Speaker 1: Hello');
    assert.match(file.headers.get('content-disposition'), /attachment/);
    assert.equal((await fetch(`${base}/v1/transcripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file":"/etc/passwd"}' })).status, 400);
  }, { transcripts: { create: () => { calls++; called(); return pending; }, list: () => [job], get: () => job,
    file: () => ({ filename: 'example-job.txt', contentType: 'text/plain', text: 'Speaker 1: Hello' }) } });
});
