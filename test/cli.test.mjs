import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { packageRelease, RELEASE_FILES, zip } from '../scripts/package-release.mjs';

const execute = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../bin/meeting-mate.mjs');
const meet = 'https://meet.google.com/abc-defg-hij'; // Fictitious fixture, never opened.
const jobId = '8be82366-8d22-4e1d-a6f0-4fdbd899be73';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-mate-cli-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function run(args, { cwd, env: extra = {} } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MEET')) delete env[key];
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extra }, timeout: 10000 });
    return { code: 0, ...result };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

async function fixture(t, respond) {
  const directory = await temporary(t);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const data of req) chunks.push(data);
    const body = Buffer.concat(chunks).toString();
    const item = { method: req.method, path: req.url, host: req.headers.host, body: body ? JSON.parse(body) : undefined };
    requests.push(item);
    const { status = 200, result = { accepted: true, status: 'queued' } } = respond?.(item) ?? {};
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  });
  t.after(close);
  const port = server.address().port;
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ meetingUrls: [meet], healthPort: port }));
  await writeFile(path.join(directory, '.env'), 'MEET_USERNAME="CLI Fixture"\n');
  return { directory, requests, port, close };
}

test('help works outside the repository without config, .env, service, or a valid project', async (t) => {
  const directory = await temporary(t);
  for (const args of [[], ['help'], ['--help'], ['join', '--help'], ['--project', '/does-not-exist', 'help']]) {
    const result = await run(args, { cwd: directory, env: { MEETING_MATE_PROJECT: '/does-not-exist' } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage: meeting-mate/);
    assert.equal(result.stderr, '');
  }
});

test('CLI resolves --project from an unrelated cwd and sends a normalized join to loopback', async (t) => {
  const api = await fixture(t);
  const elsewhere = await temporary(t);
  const result = await run(['join', `${meet}?authuser=0`, '--project', api.directory], { cwd: elsewhere });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'queued');
  assert.deepEqual(api.requests, [{ method: 'POST', path: '/v1/meetings/join', host: `127.0.0.1:${api.port}`, body: { url: meet } }]);
});

test('MEETING_MATE_PROJECT is supported, --project overrides it, and config is data only', async (t) => {
  const api = await fixture(t);
  const elsewhere = await temporary(t);
  const env = { MEETING_MATE_PROJECT: api.directory, MEETING_MATE_CONFIG: '/ignored/unrelated/config.json', HTTP_PROXY: 'http://unreachable.invalid' };
  const result = await run(['stop'], { cwd: elsewhere, env });
  assert.equal(result.code, 0, result.stderr);
  const override = await run(['--project', api.directory, 'pause'], { cwd: elsewhere, env: { MEETING_MATE_PROJECT: '/does-not-exist' } });
  assert.equal(override.code, 0, override.stderr);
  assert.deepEqual(api.requests.map(({ path: route, body }) => [route, body]), [
    ['/v1/meetings/stop', {}], ['/v1/meetings/pause', {}],
  ]);
});

test('stop/pause/resume accept an optional URL; omitted project defaults to cwd', async (t) => {
  const api = await fixture(t);
  for (const command of ['stop', 'pause', 'resume']) {
    for (const args of [[command], [command, meet]]) {
      const result = await run(args, { cwd: api.directory });
      assert.equal(result.code, 0, result.stderr);
    }
  }
  assert.deepEqual(api.requests.map(({ body }) => body), [{}, { url: meet }, {}, { url: meet }, {}, { url: meet }]);
});

test('status reads health and meetings, and recordings can be listed or inspected', async (t) => {
  const api = await fixture(t, ({ path: route }) => ({ result: route === '/healthz' ? { state: 'scheduled' }
    : route === '/v1/meetings' ? { meetings: [] } : { recordings: [] } }));
  const state = await run(['status'], { cwd: api.directory });
  assert.equal(state.code, 0, state.stderr);
  assert.deepEqual(JSON.parse(state.stdout), { health: { state: 'scheduled' }, meetings: [] });
  for (const args of [['recordings'], ['recordings', '3'], ['recording', 'fixture.mp4']]) {
    const result = await run(args, { cwd: api.directory });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.deepEqual(api.requests.map(({ path: route }) => route).sort(), [
    '/healthz', '/v1/meetings', '/v1/recordings?limit=50', '/v1/recordings?limit=3', '/v1/recordings/fixture.mp4',
  ].sort());
});

test('transcription queues an async job with optional speaker count and reads results', async (t) => {
  const api = await fixture(t, () => ({ result: { id: jobId, state: 'queued', downloads: null } }));
  for (const args of [['transcript', 'fixture.mp4'], ['transcript', 'fixture.mp4', '--speakers', '2', '--language', 'zh'],
    ['transcripts', 'list'], ['transcripts', 'list', '5'], ['transcripts', 'get', jobId]]) {
    const result = await run(args, { cwd: api.directory });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, 'queued');
  }
  assert.deepEqual(api.requests.map(({ path: route, body }) => [route, body]), [
    ['/v1/transcripts', { recordingId: 'fixture.mp4' }],
    ['/v1/transcripts', { recordingId: 'fixture.mp4', language: 'zh', numSpeakers: 2 }],
    ['/v1/transcripts?limit=50', undefined], ['/v1/transcripts?limit=5', undefined], [`/v1/transcripts/${jobId}`, undefined],
  ]);
});

test('malformed commands, flags, limits, IDs and URLs fail without contacting the API', async (t) => {
  const api = await fixture(t);
  for (const args of [['bogus'], ['status', 'extra'], ['join'], ['join', 'https://invalid.example/'],
    ['recordings', '0'], ['recordings', '101'], ['recordings', '1.5'], ['recording', '../private'],
    ['transcripts', 'get', 'not-a-uuid'], ['transcript', 'fixture.mp4', '--speakers', '21'],
    ['transcript', 'fixture.mp4', '--speakers', '2.5'], ['transcript', 'fixture.mp4', '--language', 'ZH'],
    ['status', '--speakers', '2'], ['status', '--unknown'], ['status', '--project'],
    ['status', '--project', api.directory, '--project', api.directory], ['status', '--project', '.']]) {
    const result = await run(args, { cwd: api.directory });
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
  }
  assert.equal(api.requests.length, 0);
});

test('configuration failures do not echo secrets or contact the API', async (t) => {
  const api = await fixture(t);
  const marker = 'PRIVATE_CONFIG_SENTINEL';
  await writeFile(path.join(api.directory, 'config.json'), JSON.stringify({ meetingUrls: [marker] }));
  const result = await run(['status'], { cwd: api.directory });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /config.json/);
  assert.ok(!result.stderr.includes(marker));
  assert.equal(result.stdout, '');
  assert.equal(api.requests.length, 0);
});

test('API errors return nonzero without retrying mutations', async (t) => {
  const api = await fixture(t, () => ({ status: 409, result: { error: 'recording_test_running' } }));
  const result = await run(['join', meet], { cwd: api.directory });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /HTTP 409/);
  assert.equal(api.requests.length, 1);
});

test('offline service produces an actionable nonzero result', async (t) => {
  const api = await fixture(t);
  await api.close();
  const result = await run(['status'], { cwd: api.directory });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not reachable/);
  assert.equal(result.stdout, '');
});

async function releaseFixture(t) {
  const directory = await temporary(t);
  for (const file of RELEASE_FILES) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), `approved fixture: ${file}\n`);
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'meeting-mate', version: '1.2.3', private: true }));
  return directory;
}

test('CLI packaging is deterministic, executable, checksummed, and allowlist-only', async (t) => {
  const directory = await releaseFixture(t);
  for (const name of ['.env', 'config.json', '.meeting-mate/token', 'recordings/private.mp4', 'transcripts/private.txt', 'models/private.onnx', 'src/not-approved.mjs']) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), 'PRIVATE_ARTIFACT_SENTINEL');
  }
  const first = await packageRelease({ directory, output: path.join(directory, 'out-one'), epoch: 1700000000 });
  const second = await packageRelease({ directory, output: path.join(directory, 'out-two'), epoch: 1700000000 });
  const data = await readFile(first.artifact);
  assert.deepEqual(data, await readFile(second.artifact));
  assert.equal(first.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(await readFile(`${first.artifact}.sha256`, 'utf8'), `${first.sha256}  meeting-mate-cli-v1.2.3.tgz\n`);
  assert.ok(!gunzipSync(data).includes('PRIVATE_ARTIFACT_SENTINEL'));
  const { stdout } = await execute('tar', ['-tzf', first.artifact]);
  assert.deepEqual(stdout.trim().split('\n'), [...RELEASE_FILES].sort().map((file) => `package/${file}`));
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked);
  await execute('tar', ['-xzf', first.artifact, '-C', unpacked]);
  assert.equal((await stat(path.join(unpacked, 'package/bin/meeting-mate.mjs'))).mode & 0o777, 0o755);
  assert.equal((await stat(path.join(unpacked, 'package/src/config.mjs'))).mode & 0o777, 0o644);
  await assert.rejects(packageRelease({ directory, output: path.join(directory, 'out-one') }), { code: 'EEXIST' });
});

test('packager rejects symlinked files and ancestor directories instead of following private data', async (t) => {
  const directory = await releaseFixture(t);
  const target = path.join(directory, 'PRIVATE');
  await writeFile(target, 'PRIVATE_ARTIFACT_SENTINEL');
  await rm(path.join(directory, 'README.md'));
  await symlink(target, path.join(directory, 'README.md'));
  await assert.rejects(packageRelease({ directory }), /non-regular/);
  await rm(path.join(directory, 'README.md'));
  await writeFile(path.join(directory, 'README.md'), 'fixture');
  await rm(path.join(directory, 'bin'), { recursive: true });
  const outside = await temporary(t);
  await writeFile(path.join(outside, 'meeting-mate.mjs'), 'PRIVATE_ARTIFACT_SENTINEL');
  await symlink(outside, path.join(directory, 'bin'));
  await assert.rejects(packageRelease({ directory }), /non-regular/);
});

test('packager rejects invalid kinds, timestamps, package visibility and unsafe versions', async (t) => {
  const directory = await releaseFixture(t);
  for (const options of [{ kind: 'other' }, { epoch: -1 }, { epoch: NaN }, { epoch: 0x100000000 }]) {
    await assert.rejects(packageRelease({ directory, ...options }));
  }
  for (const override of [{ private: false }, { version: '../../private' }]) {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'meeting-mate', version: '1.2.3', private: true, ...override }));
    await assert.rejects(packageRelease({ directory }), /Expected private/);
  }
});

test('native ZIP encoder preserves file bytes and executable mode without building or signing', async (t) => {
  const directory = await temporary(t);
  const entries = [
    { name: 'Meeting Mate Recorder.app/Contents/Info.plist', data: Buffer.from('fixture plist'), mode: 0o644 },
    { name: 'Meeting Mate Recorder.app/Contents/MacOS/meeting-mate-recorder', data: Buffer.from('fixture binary bytes'), mode: 0o755 },
  ];
  const data = zip(entries, 1700000000);
  assert.deepEqual(data, zip(entries, 1700000000));
  const archive = path.join(directory, 'fixture.zip');
  await writeFile(archive, data);
  await execute('unzip', ['-t', archive]);
  await execute('unzip', ['-q', archive, '-d', path.join(directory, 'unpacked')]);
  for (const entry of entries) {
    const filename = path.join(directory, 'unpacked', entry.name);
    assert.deepEqual(await readFile(filename), entry.data);
    assert.equal((await stat(filename)).mode & 0o777, entry.mode);
  }
});
