import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../src/cdp.mjs';

async function server(t, onMessage) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (socket) => socket.on('message', (raw) => onMessage(socket, JSON.parse(raw))));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const client = await new CdpConnection(`ws://127.0.0.1:${wss.address().port}`, 100).connect();
  t.after(() => client.close());
  return client;
}
test('CDP command and evaluation results', async (t) => {
  const client = await server(t, (socket, message) => socket.send(JSON.stringify({ id: message.id, result: { result: { value: 'Yumi' } } })));
  assert.equal(await client.evaluate('1'), 'Yumi');
  assert.equal(client.pending.size, 0);
});
test('evaluation opts into user activation only for explicit UI actions', async (t) => {
  const requests = [];
  const client = await server(t, (socket, message) => {
    requests.push(message.params);
    socket.send(JSON.stringify({ id: message.id, result: { result: { value: true } } }));
  });
  await client.evaluate('snapshot()');
  await client.evaluate('join()', { userGesture: true });
  assert.deepEqual(requests.map(item => item.userGesture), [false, true]);
});
test('CDP commands time out and release pending requests', async (t) => {
  const client = await server(t, () => {});
  await assert.rejects(client.send('Never.answers'), /timeout/);
  assert.equal(client.pending.size, 0);
});
test('disconnect rejects outstanding commands immediately', async (t) => {
  const client = await server(t, (socket) => socket.close());
  await assert.rejects(client.send('Pending'), /closed/);
});
test('CDP propagates protocol and evaluated exceptions', async (t) => {
  const client = await server(t, (socket, message) => socket.send(JSON.stringify(message.method === 'Runtime.evaluate'
    ? { id: message.id, result: { exceptionDetails: { text: 'Evaluation failed' } } }
    : { id: message.id, error: { message: 'Unknown method' } })));
  await assert.rejects(client.send('Unknown'), /Unknown method/);
  await assert.rejects(client.evaluate('bad()'), /Evaluation failed/);
});
test('remote CDP endpoints are rejected', () => assert.throws(() => new CdpConnection('wss://example.com/cdp'), /localhost/));
