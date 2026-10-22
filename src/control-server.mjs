import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { meetUrl } from './config.mjs';
import { apiSpec } from './openapi.mjs';

const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function jsonBody(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('Expected application/json', 415);
  if (Number(req.headers['content-length']) > 2048) throw failure('Request is too large', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) throw failure('Request is too large', 413);
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Expected a JSON object', 400);
  return body;
}
function controlStatus(result) {
  if (result.accepted) return result.status?.startsWith('already_') ? 200 : 202;
  return ['stopping', 'unavailable'].includes(result.status) ? 503 : 409;
}
async function download(req, res, catalog, id) {
  const { handle, size, recording } = await catalog.openFile(id);
  try {
    let start = 0;
    let end = size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) throw failure('Invalid byte range', 416);
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw failure('Invalid byte range', 416);
    }
    res.writeHead(req.headers.range ? 206 : 200, {
      'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      'content-length': end - start + 1, 'content-disposition': `attachment; filename="${recording.id}"`,
      ...(req.headers.range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } catch (error) {
    if (error.statusCode === 416) res.setHeader('content-range', `bytes */${size}`);
    throw error;
  } finally { await handle.close(); }
}

// index.mjs binds loopback; Host and Origin checks also reject browser pages.
export function createControlServer(report, onJoin, services = {}) {
  const requests = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(req.headers.host ?? '') || req.headers.origin) throw failure('Only local clients without a browser Origin are allowed', 403);
      const target = new URL(req.url, 'http://127.0.0.1');
      const route = target.pathname;
      if (req.method === 'GET') {
        if (route === '/v1/openapi.json') { send(res, 200, apiSpec(req.socket.localPort)); return; }
        if (route === '/healthz') { send(res, 200, report()); return; }
        if (route === '/v1/meetings') { send(res, 200, { meetings: report().meetings }); return; }
        if (route === '/v1/recordings' && services.recordings) {
          send(res, 200, { recordings: await services.recordings.list(Number(target.searchParams.get('limit') ?? 50)) }); return;
        }
        const recording = /^\/v1\/recordings\/([^/]+)(\/file)?$/.exec(route);
        if (recording && services.recordings) {
          const id = decodeURIComponent(recording[1]);
          if (recording[2]) await download(req, res, services.recordings, id);
          else send(res, 200, await services.recordings.get(id));
          return;
        }
        if (route === '/v1/diagnostics' && services.diagnostics) { send(res, 200, await services.diagnostics()); return; }
        if (route === '/v1/transcripts' && services.transcripts) {
          send(res, 200, { transcripts: services.transcripts.list(Number(target.searchParams.get('limit') ?? 50)) }); return;
        }
        const transcript = /^\/v1\/transcripts\/([^/]+)(\/file)?$/.exec(route);
        if (transcript && services.transcripts) {
          const id = decodeURIComponent(transcript[1]);
          if (!transcript[2]) send(res, 200, await services.transcripts.get(id));
          else {
            const file = await services.transcripts.file(id, target.searchParams.get('format') ?? 'txt');
            res.writeHead(200, { 'content-type': file.contentType, 'cache-control': 'no-store',
              'content-disposition': `attachment; filename="${file.filename}"`, 'x-content-type-options': 'nosniff' });
            res.end(file.text);
          }
          return;
        }
        const test = /^\/v1\/recording-tests\/([^/]+)$/.exec(route);
        if (test && services.recordingTests) {
          const job = await services.recordingTests.get(decodeURIComponent(test[1]));
          if (!job) throw failure('Recording test not found', 404);
          send(res, 200, job); return;
        }
      }
      const action = route === '/join' ? 'join' : /^\/v1\/meetings\/(join|stop|pause|resume)$/.exec(route)?.[1];
      const testStart = route === '/v1/recording-tests' && services.recordingTests;
      const transcriptStart = route === '/v1/transcripts' && services.transcripts;
      if (req.method !== 'POST' || (!action && !testStart && !transcriptStart)) throw failure('Not found', 404);
      const body = await jsonBody(req);
      const allowed = transcriptStart ? ['recordingId', 'language', 'numSpeakers'] : action ? ['url'] : [];
      if (Object.keys(body).some((key) => !allowed.includes(key))) throw failure('Unknown request field', 400);
      let url;
      if (action && (action === 'join' || body.url !== undefined)) {
        try { if (typeof body.url !== 'string') throw new Error(); url = meetUrl(body.url); }
        catch { throw failure('Invalid Google Meet URL', 400); }
      }
      const key = req.headers['idempotency-key'];
      if (key && (typeof key !== 'string' || key.length > 128)) throw failure('Invalid Idempotency-Key', 400);
      const fingerprint = JSON.stringify([route, body]);
      for (const [id, item] of requests) if (item.expires < Date.now()) requests.delete(id);
      if (key && requests.has(key)) {
        const saved = requests.get(key);
        if (saved.fingerprint !== fingerprint) throw failure('Idempotency-Key was already used for another request', 409);
        const savedResult = await saved.pending;
        send(res, savedResult.code, savedResult.result); return;
      }
      const pending = (async () => {
        let result;
        if (transcriptStart) result = await services.transcripts.create(body);
        else if (testStart) result = services.recordingTests.start();
        else if (action === 'join') result = onJoin(url);
        else if (services.onControl) result = services.onControl(action, url);
        else throw failure('Control action is unavailable', 503);
        return { result, code: testStart || transcriptStart ? 202 : controlStatus(result) };
      })();
      if (key) {
        if (requests.size >= 200) requests.delete(requests.keys().next().value);
        requests.set(key, { fingerprint, pending, expires: Date.now() + 3600000 });
      }
      let result, code;
      try { ({ result, code } = await pending); }
      catch (error) { if (key && requests.get(key)?.pending === pending) requests.delete(key); throw error; }
      send(res, code, result);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.statusCode ?? (error instanceof SyntaxError || error instanceof URIError ? 400 : 500), { error: error.message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 15000;
  return server;
}
