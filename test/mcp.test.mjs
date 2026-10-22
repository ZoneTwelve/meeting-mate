import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiError, API_MAX_RESPONSE_BYTES, createApiClient } from '../src/api-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = 'https://meet.google.com/abc-defg-hij';
const recording = { id: 'recording-001.mp4', file: '/tmp/meeting-mate-recordings/recording-001.mp4', downloadUrl: '/v1/recordings/recording-001.mp4/file', duration: 10 };
const transcriptId = '8be82366-8d22-4e1d-a6f0-4fdbd899be73';
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function fakeApi(t, respond) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const request = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
      requests.push(request);
      await respond(request, res);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) send(res, 500, { error: 'Fake API handler failed' });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = async () => {
    if (!server.listening) return;
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await done;
  };
  t.after(async () => { await close(); assert.deepEqual(errors, []); });
  return { port: server.address().port, requests, close };
}

async function stdioClient(t, port) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-mate-mcp-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'config.json');
  await fs.writeFile(filename, JSON.stringify({ meetingUrls: [url], healthPort: port }), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src', 'mcp.mjs')],
    // Prove config loading does not rely on the MCP host's working directory.
    cwd: directory,
    env: { MEETING_MATE_CONFIG: filename, MEET_USERNAME: 'MCP Test' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const protocolErrors = [];
  const client = new Client({ name: 'meeting-mate-test', version: '1.0.0' });
  client.onerror = (error) => protocolErrors.push(error);
  t.after(async () => {
    await client.close();
    assert.deepEqual(protocolErrors, [], `Unexpected protocol error; stderr: ${stderr}`);
    assert.equal(stderr, '', 'A healthy MCP child should not emit warnings or errors');
  });
  await client.connect(transport);
  return client;
}

function output(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

test('real SDK stdio handshake and tools/list advertise all tools without contacting the API', { timeout: 10_000 }, async (t) => {
  const api = await fakeApi(t, (_req, res) => send(res, 500, { error: 'Unexpected request' }));
  const client = await stdioClient(t, api.port);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'meet_join', 'meet_stop', 'meet_pause', 'meet_resume', 'meet_status',
    'recordings_list', 'recording_get', 'recording_test_start', 'recording_test_status', 'recorder_diagnostics',
    'transcript_create', 'transcripts_list', 'transcript_get',
  ].sort());
  assert.equal(client.getServerVersion().name, 'meeting-mate');
  assert.deepEqual(api.requests, []);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint}`);
    }
  }
  for (const name of ['meet_status', 'recordings_list', 'recording_get', 'recording_test_status', 'recorder_diagnostics', 'transcripts_list', 'transcript_get']) {
    assert.equal(byName[name].annotations.readOnlyHint, true);
    assert.equal(byName[name].annotations.openWorldHint, false);
  }
  assert.deepEqual(byName.meet_join.inputSchema.required, ['url']);
  assert.equal(byName.meet_join.annotations.openWorldHint, true);
  assert.equal(byName.meet_join.annotations.idempotentHint, true);
  assert.equal(byName.meet_pause.annotations.destructiveHint, true);
  assert.equal(byName.meet_stop.annotations.destructiveHint, true);
  assert.equal(byName.recording_test_start.annotations.readOnlyHint, false);
  assert.equal(byName.recording_test_start.annotations.idempotentHint, false);
  assert.deepEqual(byName.transcript_create.inputSchema.required, ['recordingId']);
  assert.deepEqual(byName.transcript_get.inputSchema.required, ['id']);
  assert.deepEqual(byName.transcript_create.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
});

test('real SDK tools/call forwards meeting and recording operations to the agreed local API routes', { timeout: 15_000 }, async (t) => {
  const health = { state: 'recording', username: 'MCP Test' };
  const meetings = [{ url, state: 'recording' }];
  const testRecord = { id: 'test-001', state: 'running' };
  const api = await fakeApi(t, (req, res) => {
    if (req.path === '/healthz') return send(res, 200, health);
    if (req.path === '/v1/meetings') return send(res, 200, { meetings });
    if (req.method === 'POST' && req.path.startsWith('/v1/meetings/')) {
      return send(res, req.body.url ? 202 : 200, { accepted: true, status: req.body.url ? 'queued' : 'already', url: req.body.url ?? url });
    }
    if (req.path.startsWith('/v1/recordings?')) return send(res, 200, { recordings: [recording] });
    if (req.path === '/v1/recordings/recording-001.mp4') return send(res, 200, recording);
    if (req.path === '/v1/recording-tests') return send(res, 202, testRecord);
    if (req.path.startsWith('/v1/recording-tests/')) return send(res, 200, { ...testRecord, state: 'passed' });
    if (req.path === '/v1/diagnostics') return send(res, 200, { screenPermission: true });
    return send(res, 404, { error: 'Unexpected path' });
  });
  const client = await stdioClient(t, api.port);
  const call = async (name, args, expected) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false);
    assert.deepEqual(output(result), expected);
  };
  await call('meet_status', {}, { health, meetings });
  for (const action of ['join', 'stop', 'pause', 'resume']) {
    await call(`meet_${action}`, { url: `${url}?authuser=0` }, { accepted: true, status: 'queued', url });
  }
  for (const action of ['stop', 'pause', 'resume']) {
    await call(`meet_${action}`, {}, { accepted: true, status: 'already', url });
  }
  await call('recordings_list', {}, { recordings: [recording] });
  await call('recordings_list', { limit: 3 }, { recordings: [recording] });
  await call('recording_get', { id: recording.id }, recording);
  await call('recording_test_start', {}, testRecord);
  await call('recording_test_status', { id: 'test-001' }, { ...testRecord, state: 'passed' });
  await call('recording_test_status', {}, { ...testRecord, state: 'passed' });
  await call('recorder_diagnostics', {}, { screenPermission: true });
  assert.deepEqual(api.requests.map(({ method, path: route, body }) => ({ method, path: route, body })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    { method: 'GET', path: '/healthz', body: undefined },
    { method: 'GET', path: '/v1/meetings', body: undefined },
    ...['join', 'stop', 'pause', 'resume'].map((action) => ({ method: 'POST', path: `/v1/meetings/${action}`, body: { url } })),
    ...['stop', 'pause', 'resume'].map((action) => ({ method: 'POST', path: `/v1/meetings/${action}`, body: {} })),
    { method: 'GET', path: '/v1/recordings?limit=50', body: undefined },
    { method: 'GET', path: '/v1/recordings?limit=3', body: undefined },
    { method: 'GET', path: '/v1/recordings/recording-001.mp4', body: undefined },
    { method: 'POST', path: '/v1/recording-tests', body: {} },
    { method: 'GET', path: '/v1/recording-tests/test-001', body: undefined },
    { method: 'GET', path: '/v1/recording-tests/latest', body: undefined },
    { method: 'GET', path: '/v1/diagnostics', body: undefined },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  for (const request of api.requests) {
    assert.equal(request.headers.host, `127.0.0.1:${api.port}`);
    assert.equal(request.headers.origin, undefined);
    if (request.method === 'POST') assert.equal(request.headers['content-type'], 'application/json');
  }
});

test('transcript tools forward asynchronous jobs and return local download references without fetching files', { timeout: 15_000 }, async (t) => {
  let job = {
    id: transcriptId, state: 'queued', recordingId: recording.id, sessionId: 'session-001',
    recordingIds: [recording.id, 'recording-002.mp4'], result: null,
  };
  const api = await fakeApi(t, (req, res) => {
    if (req.method === 'POST' && req.path === '/v1/transcripts') return send(res, job.state === 'completed' ? 200 : 202, job);
    if (req.path.startsWith('/v1/transcripts?limit=')) return send(res, 200, { transcripts: [job], total: 1 });
    if (req.path === `/v1/transcripts/${transcriptId}`) return send(res, 200, job);
    return send(res, 500, { error: 'Unexpected route; MCP must not fetch transcript file bytes' });
  });
  const client = await stdioClient(t, api.port);
  const call = async (name, args, expected) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false);
    assert.deepEqual(output(result), expected);
  };
  await call('transcript_create', { recordingId: recording.id }, { ...job, downloads: null });
  const input = { recordingId: recording.id, language: 'zh', numSpeakers: 2, idempotencyKey: 'transcript-001' };
  await call('transcript_create', input, { ...job, downloads: null });
  await call('transcript_create', { recordingId: recording.id, language: 'auto', numSpeakers: 20 }, { ...job, downloads: null });
  await call('transcript_create', { recordingId: recording.id, language: 'eng', numSpeakers: 1 }, { ...job, downloads: null });
  await call('transcripts_list', {}, { transcripts: [{ ...job, downloads: null }], total: 1 });
  await call('transcripts_list', { limit: 3 }, { transcripts: [{ ...job, downloads: null }], total: 1 });
  await call('transcript_get', { id: transcriptId }, { ...job, downloads: null });
  job = { ...job, state: 'running' };
  await call('transcript_get', { id: transcriptId }, { ...job, downloads: null });
  job = { ...job, state: 'completed', result: {
    jobId: transcriptId, language: 'zh', duration: 3,
    speakers: [{ id: 'speaker_1', label: 'Speaker 1' }, { id: 'speaker_2', label: 'Speaker 2' }],
    segments: [
      { start: 0, end: 1.5, speakerId: 'speaker_1', text: '會議開始。', recordingId: recording.id },
      { start: 1.5, end: 3, speakerId: 'speaker_2', text: '收到。', recordingId: recording.id },
    ],
  } };
  const downloads = Object.fromEntries(['txt', 'json', 'srt', 'vtt'].map((format) => [format,
    `http://127.0.0.1:${api.port}/v1/transcripts/${transcriptId}/file?format=${format}`]));
  await call('transcript_get', { id: transcriptId }, { ...job, downloads });
  await call('transcripts_list', { limit: 100 }, { transcripts: [{ ...job, downloads }], total: 1 });
  // A service may reuse completed work and return 200 instead of creating a new job.
  await call('transcript_create', input, { ...job, downloads });
  job = { ...job, sessionId: null, recordingIds: [recording.id] };
  await call('transcript_get', { id: transcriptId }, { ...job, downloads });
  assert.deepEqual(api.requests.map(({ method, path: route, body }) => ({ method, path: route, body })), [
    { method: 'POST', path: '/v1/transcripts', body: { recordingId: recording.id } },
    { method: 'POST', path: '/v1/transcripts', body: { recordingId: recording.id, language: 'zh', numSpeakers: 2 } },
    { method: 'POST', path: '/v1/transcripts', body: { recordingId: recording.id, language: 'auto', numSpeakers: 20 } },
    { method: 'POST', path: '/v1/transcripts', body: { recordingId: recording.id, language: 'eng', numSpeakers: 1 } },
    { method: 'GET', path: '/v1/transcripts?limit=50', body: undefined },
    { method: 'GET', path: '/v1/transcripts?limit=3', body: undefined },
    ...Array.from({ length: 3 }, () => ({ method: 'GET', path: `/v1/transcripts/${transcriptId}`, body: undefined })),
    { method: 'GET', path: '/v1/transcripts?limit=100', body: undefined },
    { method: 'POST', path: '/v1/transcripts', body: { recordingId: recording.id, language: 'zh', numSpeakers: 2 } },
    { method: 'GET', path: `/v1/transcripts/${transcriptId}`, body: undefined },
  ]);
  assert.equal(api.requests[0].headers['idempotency-key'], undefined);
  assert.equal(api.requests[1].headers['idempotency-key'], 'transcript-001');
  assert.equal(api.requests[10].headers['idempotency-key'], 'transcript-001');
  for (const request of api.requests) {
    assert.equal(request.headers.host, `127.0.0.1:${api.port}`);
    assert.equal(request.headers.origin, undefined);
    assert.ok(!request.path.includes('/file'));
  }
});

test('transcript HTTP errors are MCP errors; failed jobs remain readable and retry is explicit', { timeout: 15_000 }, async (t) => {
  let failure;
  let job = { id: transcriptId, state: 'failed', result: null, error: 'Local diarization model is unavailable' };
  const api = await fakeApi(t, (req, res) => {
    if (failure) return send(res, failure.status, failure.body);
    if (req.method === 'POST') return send(res, 202, job);
    return send(res, 200, job);
  });
  const client = await stdioClient(t, api.port);
  const failed = await client.callTool({ name: 'transcript_get', arguments: { id: transcriptId } });
  assert.equal(failed.isError, false);
  assert.deepEqual(output(failed), { ...job, downloads: null });
  assert.equal(api.requests.length, 1, 'Reading failure must not trigger a retry');
  for (const [name, args, status, body] of [
    ['transcript_create', { recordingId: recording.id }, 409, { error: 'Recording session is still active' }],
    ['transcript_create', { recordingId: recording.id }, 503, { error: 'Local transcript worker unavailable' }],
    ['transcript_create', { recordingId: recording.id, language: 'zz' }, 400, { error: 'Unsupported language code' }],
    ['transcript_get', { id: transcriptId }, 404, { error: 'Transcript not found' }],
  ]) {
    failure = { status, body };
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    const { error } = output(result);
    assert.equal(error.code, 'http_error');
    assert.equal(error.httpStatus, status);
    assert.deepEqual(error.details, body);
  }
  failure = null;
  job = { id: '17f8af4a-52b7-4b77-97c3-ce0fa313da8b', state: 'queued', result: null };
  const retry = await client.callTool({ name: 'transcript_create', arguments: { recordingId: recording.id, idempotencyKey: 'retry-002' } });
  assert.equal(retry.isError, false);
  assert.deepEqual(output(retry), { ...job, downloads: null });
  assert.equal(api.requests.length, 6, 'No implicit HTTP retries');
  assert.equal(api.requests.at(-1).headers['idempotency-key'], 'retry-002');
});

test('transcript tools reject malformed jobs and do not turn returned paths into download targets', { timeout: 15_000 }, async (t) => {
  let response;
  const api = await fakeApi(t, (_req, res) => send(res, 200, response));
  const client = await stdioClient(t, api.port);
  for (const value of [
    {}, { id: '../../file', state: 'completed' }, { id: transcriptId, state: 'unexpected' },
    { id: 'https://example.com', state: 'completed' },
  ]) {
    response = value;
    const result = await client.callTool({ name: 'transcript_get', arguments: { id: transcriptId } });
    assert.equal(result.isError, true);
    assert.equal(output(result).error.code, 'invalid_response');
  }
  response = { transcripts: 'not-an-array' };
  const invalid = await client.callTool({ name: 'transcripts_list', arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(output(invalid).error.code, 'invalid_response');
  response = { transcripts: [] };
  const empty = await client.callTool({ name: 'transcripts_list', arguments: {} });
  assert.equal(empty.isError, false);
  assert.deepEqual(output(empty), { transcripts: [] });
  assert.equal(api.requests.length, 6);
});

test('large transcript results return bounded metadata and local references instead of overflowing stdio', { timeout: 15_000 }, async (t) => {
  const api = await fakeApi(t, (_req, res) => send(res, 200, {
    id: transcriptId, state: 'completed', result: {
      jobId: transcriptId, duration: 12000, language: 'zh', speakers: [{ id: 'speaker_1', label: 'Speaker 1' }],
      segments: Array.from({ length: 1200 }, (_, index) => ({
        start: index * 10, end: index * 10 + 5, speakerId: 'speaker_1', recordingId: 'long-session.mp4', text: '字'.repeat(1024),
      })),
    },
  }));
  const client = await stdioClient(t, api.port);
  const result = await client.callTool({ name: 'transcript_get', arguments: { id: transcriptId } });
  assert.equal(result.isError, false);
  const job = output(result);
  assert.equal(job.state, 'completed');
  assert.equal(job.result, null);
  assert.equal(job.resultOmitted, true);
  assert.match(job.resultMessage, /downloads.json/);
  assert.equal(job.downloads.json, `http://127.0.0.1:${api.port}/v1/transcripts/${transcriptId}/file?format=json`);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assert.deepEqual(api.requests.map((req) => req.path), [`/v1/transcripts/${transcriptId}`]);
});

test('API conflicts, not-found and service failures become meaningful MCP isError results', { timeout: 15_000 }, async (t) => {
  const failures = {
    '/v1/meetings/join': [409, { accepted: false, status: 'busy', activeUrl: url }],
    '/v1/meetings/pause': [409, { accepted: false, status: 'not_in_call' }],
    '/v1/meetings/stop': [200, { accepted: false, status: 'stopping' }],
    '/v1/recordings/missing': [404, { error: 'Recording not found' }],
    '/v1/diagnostics': [503, { error: { message: 'Recorder unavailable' } }],
  };
  const api = await fakeApi(t, (req, res) => send(res, ...failures[req.path]));
  const client = await stdioClient(t, api.port);
  for (const [name, args, route] of [
    ['meet_join', { url }, '/v1/meetings/join'],
    ['meet_pause', {}, '/v1/meetings/pause'],
    ['meet_stop', {}, '/v1/meetings/stop'],
    ['recording_get', { id: 'missing' }, '/v1/recordings/missing'],
    ['recorder_diagnostics', {}, '/v1/diagnostics'],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    const { error } = output(result);
    assert.equal(error.httpStatus, failures[route][0]);
    assert.deepEqual(error.details, failures[route][1]);
    assert.equal(error.code, route.endsWith('/stop') ? 'request_rejected' : 'http_error');
    assert.ok(error.message.length > 0);
  }
  assert.equal(api.requests.length, 5, 'Mutations must never be automatically retried');
});

test('SDK validation rejects paths, arbitrary destinations and unknown input fields before HTTP', { timeout: 15_000 }, async (t) => {
  const api = await fakeApi(t, (_req, res) => send(res, 500, { error: 'Unexpected request' }));
  const client = await stdioClient(t, api.port);
  const invalid = [
    ['meet_join', {}],
    ['meet_join', { url: 'http://127.0.0.1:8787/healthz' }],
    ['meet_join', { url: 'https://meet.google.com.evil.example/abc-defg-hij' }],
    ['meet_join', { url: 'https://name:password@meet.google.com/abc-defg-hij' }],
    ['meet_pause', { url: '/tmp/meeting' }],
    ['meet_resume', { url: null }],
    ['meet_stop', { url, endpoint: 'https://example.com' }],
    ['recording_get', { id: '../../.env' }],
    ['recording_get', { id: '%2e%2e%2f.env' }],
    ['recording_get', { id: 'https://example.com/video.mp4' }],
    ['recording_get', { id: '/tmp/movie.mp4' }],
    ['recording_test_status', { id: 'test?id=../' }],
    ['recording_test_start', { path: '/tmp/output.mp4' }],
    ['meet_status', { baseUrl: 'https://example.com' }],
    ['recordings_list', { limit: 0 }],
    ['recordings_list', { limit: 1.5 }],
    ['recordings_list', { limit: 101 }],
    ['recordings_list', { limit: '50' }],
    ['recorder_diagnostics', { restart: true }],
    ['meet_join', { url, idempotencyKey: '' }],
    ['meet_pause', { idempotencyKey: 'x'.repeat(129) }],
    ['recording_test_start', { idempotencyKey: 'key\r\nHost: example.com' }],
    ['recorder_diagnostics', { idempotencyKey: 'read-key' }],
    ['transcript_create', {}],
    ['transcript_create', { recordingId: '/tmp/recording.mp4' }],
    ['transcript_create', { recordingId: 'https://example.com/recording.mp4' }],
    ['transcript_create', { recordingId: '../recording.mp4' }],
    ['transcript_create', { recordingId: recording.id, language: 'english' }],
    ['transcript_create', { recordingId: recording.id, language: 'zh-TW' }],
    ['transcript_create', { recordingId: recording.id, language: null }],
    ['transcript_create', { recordingId: recording.id, numSpeakers: 0 }],
    ['transcript_create', { recordingId: recording.id, numSpeakers: 21 }],
    ['transcript_create', { recordingId: recording.id, numSpeakers: 1.5 }],
    ['transcript_create', { recordingId: recording.id, numSpeakers: '2' }],
    ['transcript_create', { recordingId: recording.id, path: '/tmp/out.txt' }],
    ['transcript_create', { recordingId: recording.id, speakerNames: { SPEAKER_00: 'Alice' } }],
    ['transcript_create', { recordingId: recording.id, idempotencyKey: 'key\nHost: example.com' }],
    ['transcript_get', { id: 'latest' }],
    ['transcript_get', { id: '../transcripts' }],
    ['transcript_get', { id: `${transcriptId}/file?format=txt` }],
    ['transcript_get', { id: 'https://example.com/transcript' }],
    ['transcript_get', { id: transcriptId, format: 'txt' }],
    ['transcripts_list', { limit: 0 }],
    ['transcripts_list', { limit: 101 }],
    ['transcripts_list', { limit: 1.5 }],
    ['transcripts_list', { limit: '50' }],
  ];
  for (const [name, args] of invalid) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, /validation|invalid|expected/i);
  }
  assert.deepEqual(api.requests, []);
});

test('POST idempotency keys are forwarded as headers, not JSON or automatic retries', { timeout: 10_000 }, async (t) => {
  const api = await fakeApi(t, (req, res) => send(res, 202, { accepted: true, key: req.headers['idempotency-key'] }));
  const client = await stdioClient(t, api.port);
  for (const action of ['join', 'stop', 'pause', 'resume']) {
    const result = await client.callTool({ name: `meet_${action}`, arguments: { url, idempotencyKey: `action-${action}` } });
    assert.equal(result.isError, false);
    assert.equal(output(result).key, `action-${action}`);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.callTool({ name: 'recording_test_start', arguments: { idempotencyKey: 'test:retry-001' } });
    assert.equal(result.isError, false);
    assert.equal(output(result).key, 'test:retry-001');
  }
  assert.equal(api.requests.length, 6);
  for (const request of api.requests) {
    assert.equal(request.body.idempotencyKey, undefined);
    assert.deepEqual(request.body, request.path === '/v1/recording-tests' ? {} : { url });
  }
});

test('MCP reports unavailable API without spawning a monitor and remains usable for tools/list', { timeout: 10_000 }, async (t) => {
  const api = await fakeApi(t, (_req, res) => send(res, 200, {}));
  const client = await stdioClient(t, api.port);
  await api.close();
  const result = await client.callTool({ name: 'recorder_diagnostics', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(output(result).error.code, 'service_unavailable');
  assert.match(output(result).error.message, /pnpm run install:launchd/);
  assert.equal((await client.listTools()).tools.length, 13);
});

test('MCP reports malformed and oversized responses while returning failed test records as data', { timeout: 15_000 }, async (t) => {
  const api = await fakeApi(t, (req, res) => {
    if (req.path.endsWith('/large')) return res.end('x'.repeat(API_MAX_RESPONSE_BYTES + 1));
    if (req.path.endsWith('/array')) return send(res, 200, []);
    if (req.path.endsWith('/null')) return send(res, 200, null);
    if (req.path.endsWith('/latest')) return send(res, 200, { id: 'test-002', state: 'failed', error: 'No audio detected' });
    res.end('<html>Not JSON</html>');
  });
  const client = await stdioClient(t, api.port);
  for (const id of ['malformed', 'array', 'null', 'large']) {
    const result = await client.callTool({ name: 'recording_get', arguments: { id } });
    assert.equal(result.isError, true);
    assert.equal(output(result).error.code, id === 'large' ? 'response_too_large' : 'invalid_response');
  }
  const result = await client.callTool({ name: 'recording_test_status', arguments: {} });
  assert.equal(result.isError, false, 'Reading a failed test succeeded; its state describes the test failure');
  assert.deepEqual(output(result), { id: 'test-002', state: 'failed', error: 'No audio detected' });
});

test('API redirects are errors and are never followed, including on mutations', { timeout: 10_000 }, async (t) => {
  const destination = await fakeApi(t, (_req, res) => send(res, 200, { accepted: true }));
  const api = await fakeApi(t, (_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${destination.port}/redirected` });
    res.end();
  });
  const client = await stdioClient(t, api.port);
  const result = await client.callTool({ name: 'meet_join', arguments: { url } });
  assert.equal(result.isError, true);
  assert.equal(output(result).error.httpStatus, 307);
  assert.match(output(result).error.message, /Redirects are not allowed/);
  assert.equal(api.requests.length, 1);
  assert.deepEqual(destination.requests, []);
});

test('HTTP deadline covers the response body, and timed-out mutations are not retried', { timeout: 5000 }, async (t) => {
  const api = await fakeApi(t, (_req, res) => {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.write('{');
  });
  const client = createApiClient({ healthPort: api.port }, { timeoutMs: 80 });
  await assert.rejects(client.recordingTestStart(), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.match(error.message, /may have accepted.*check meet_status or recording_test_status/);
    return true;
  });
  await assert.rejects(client.transcriptCreate({ recordingId: recording.id }), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.match(error.message, /may have accepted.*check transcripts_list or transcript_get/);
    return true;
  });
  assert.equal(api.requests.length, 2);
});

test('HTTP requests respect cancellation without retrying', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const api = await fakeApi(t, () => controller.abort());
  const client = createApiClient({ healthPort: api.port });
  await assert.rejects(client.recordingTestStart({ signal: controller.signal }), (error) => error.code === 'request_aborted');
  assert.equal(api.requests.length, 1);
});

test('HTTP client validates ports, IDs and limits independently of the MCP schema', () => {
  for (const healthPort of [0, 65536, 1.5, '8787', undefined]) {
    assert.throws(() => createApiClient({ healthPort }), /healthPort/);
  }
  const client = createApiClient({ healthPort: 1 });
  assert.equal(client.request, undefined);
  for (const id of ['..', '../secret', '/tmp/file', 'https://example.com', 'x\\y', 'x?foo', 'x#foo']) {
    assert.throws(() => client.recordingGet(id), ApiError);
    assert.throws(() => client.recordingTestStatus(id), ApiError);
  }
  assert.throws(() => client.join(), ApiError);
  assert.throws(() => client.join('http://example.com'), ApiError);
  assert.throws(() => client.recordingsList(0), ApiError);
  assert.throws(() => client.join(url, { idempotencyKey: 'x\nheader' }), ApiError);
  assert.throws(() => client.recordingTestStart({ idempotencyKey: 'x'.repeat(129) }), ApiError);
  for (const input of [
    undefined, null, [], {}, { recordingId: '/tmp/file.mp4' }, { recordingId: recording.id, language: 'english' },
    { recordingId: recording.id, numSpeakers: 0 }, { recordingId: recording.id, numSpeakers: 21 },
    { recordingId: recording.id, numSpeakers: 1.5 }, { recordingId: recording.id, output: '/tmp/out.txt' },
  ]) assert.throws(() => client.transcriptCreate(input), ApiError);
  for (const id of ['latest', recording.id, '../file', 'https://example.com', `${transcriptId}/file`]) {
    assert.throws(() => client.transcriptGet(id), ApiError);
  }
  for (const limit of [0, 101, 1.5, '50']) assert.throws(() => client.transcriptsList(limit), ApiError);
});
