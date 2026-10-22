import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Recordings } from '../src/recordings.mjs';
import { createControlServer } from '../src/control-server.mjs';

async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-mate-catalog-'));
  const catalog = new Recordings({ recordingsDir: dir, healthPort: 8787 });
  const add = async (id, status = 'verified', startedAt = '2026-10-22T12:00:00Z') => {
    await writeFile(path.join(dir, id), '0123456789');
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ status, startedAt, meetingUrl: 'https://meet.google.com/abc-defg-hij', media: { file: '/arbitrary/private-file', duration: 10, video: 'h264', audio: 'aac' } }));
  };
  try { await run({ dir, catalog, add }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('catalog orders by recording time and never trusts file paths in metadata', async () => fixture(async ({ dir, catalog, add }) => {
  await add('zzz-old.mp4');
  await add('aaa-new.mp4', 'verified', '2026-10-22T13:00:00Z');
  const [item] = await catalog.list(1);
  assert.equal(item.id, 'aaa-new.mp4');
  assert.equal(item.file, path.join(await realpath(dir), item.id));
  assert.equal(item.bytes, 10);
  assert.match(item.downloadUrl, /\/v1\/recordings\/aaa-new.mp4\/file$/);
}));
test('unfinished recordings cannot be downloaded and unsafe IDs are rejected', async () => fixture(async ({ catalog, add }) => {
  await add('active.mp4', 'recording');
  await assert.rejects(catalog.openFile('active.mp4'), (error) => error.statusCode === 409);
  await assert.rejects(catalog.get('../secret.mp4'), (error) => error.statusCode === 400);
  await assert.rejects(catalog.list(0), (error) => error.statusCode === 400);
}));
test('symlink metadata or media cannot expose an external file', async () => fixture(async ({ dir, catalog, add }) => {
  await add('valid.mp4');
  await symlink(path.join(dir, 'valid.mp4.json'), path.join(dir, 'linked.mp4.json'));
  await assert.rejects(catalog.get('linked.mp4'), (error) => error.statusCode === 404);
  await writeFile(path.join(dir, 'media-link.mp4.json'), JSON.stringify({ status: 'verified' }));
  await symlink(path.join(dir, 'valid.mp4'), path.join(dir, 'media-link.mp4'));
  assert.equal((await catalog.get('media-link.mp4')).available, false);
  await assert.rejects(catalog.openFile('media-link.mp4'), (error) => error.statusCode === 404);
}));
test('HTTP downloads support byte ranges and reject unfinished or escaped paths', async () => fixture(async ({ catalog, add }) => {
  await add('ready.mp4');
  await add('active.mp4', 'recording');
  const server = createControlServer(() => ({}), () => ({}), { recordings: catalog });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/recordings`;
  try {
    const response = await fetch(`${base}/ready.mp4/file`, { headers: { range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
    assert.equal((await fetch(`${base}/ready.mp4/file`, { headers: { range: 'bytes=20-' } })).status, 416);
    assert.equal((await fetch(`${base}/active.mp4/file`)).status, 409);
    assert.equal((await fetch(`${base}/..%2Fsecret.mp4`)).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));
