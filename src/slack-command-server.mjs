import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySlackRequest(body, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !/^\d{10}$/.test(timestamp ?? '') || !/^v0=[a-f0-9]{64}$/.test(signature ?? '') ||
      Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(`v0=${expected}`), Buffer.from(signature));
}

// This listener deliberately exposes no recorder API, files, or credentials.
export function commandServer({ signingSecret, appId, teamId, accept, now = Date.now, log = console.log }) {
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 2500, headersTimeout: 2500 }, async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.url === '/healthz' && req.method === 'GET') return send(200, { ok: true });
      if (!['/meeting', '/meeting-stop'].includes(req.url)) return send(404, { error: 'not_found' });
      if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
      if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) return send(415, { error: 'unsupported_body' });
      const chunks = []; let size = 0;
      req.setTimeout(2500, () => req.destroy());
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) { send(413, { error: 'body_too_large' }); req.resume(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verifySlackRequest(raw, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'], signingSecret, now())) return send(401, { error: 'invalid_signature' });
      const form = new URLSearchParams(raw.toString('utf8'));
      const fields = ['api_app_id', 'team_id', 'channel_id', 'user_id', 'command', 'text', 'trigger_id'];
      if (fields.some(key => form.getAll(key).length !== 1)) return send(400, { error: 'invalid_form' });
      const slash = form.get('command');
      if (form.get('team_id') !== teamId || form.get('api_app_id') !== appId || !['/meeting', '/meeting-stop'].includes(slash) ||
          (req.url === '/meeting-stop' && slash !== '/meeting-stop')) return send(403, { error: 'wrong_installation' });
      if (!/^[CDG][A-Z0-9]+$/.test(form.get('channel_id')) || !/^[UW][A-Z0-9]+$/.test(form.get('user_id')) || !form.get('trigger_id') || form.get('text').length > 8000) return send(400, { error: 'invalid_form' });
      // Only normalized, necessary fields cross the boundary; response_url,
      // verification token, signature, and raw body are never stored or logged.
      const text = await accept({ channel: form.get('channel_id'), user: form.get('user_id'), text: form.get('text'), trigger: form.get('trigger_id'), slash });
      send(200, { response_type: 'ephemeral', text });
    } catch {
      log('Slash command could not be persisted.');
      if (!res.headersSent && !res.destroyed) send(503, { error: 'temporarily_unavailable' });
    }
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}
