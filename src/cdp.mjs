import WebSocket from 'ws';

export class CdpConnection {
  constructor(url, timeoutMs = 8000) {
    const endpoint = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('CDP must be on localhost');
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
  }
  async connect() {
    const socket = this.socket = new WebSocket(this.url, { handshakeTimeout: this.timeoutMs });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { this.fail(new Error('Invalid CDP response')); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Chrome connection closed')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('CDP connection timeout')); }, this.timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('CDP closed before opening')); });
    });
    return this;
  }
  fail(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.fail(new Error('CDP closed')); this.socket?.terminate(); }
}

export async function cdpJson(port, route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome HTTP ${response.status}`);
  return response.json();
}
