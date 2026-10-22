import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { collectSnapshot, DEFAULT_INTERVAL_MINUTES, LABEL, launchdPlist, manageAgent, MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES, parseNumstat, parseStatus, recordSnapshot, safePath } from '../scripts/repo-watch.mjs';

const execute = promisify(execFile);
const oid = 'a'.repeat(40);
const sourceRoot = path.resolve(import.meta.dirname, '..');

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meeting-mate-repo-watch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function git(directory, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Repo Watch Test',
    '-c', 'user.email=repo-watch-test@example.invalid', ...args], { cwd: directory, env });
}

async function repository(t) {
  const directory = await temporary(t);
  await git(directory, 'init', '--quiet', '-b', 'main');
  await writeFile(path.join(directory, '.gitignore'), '.meeting-mate/\n.env\nconfig.json\nrecordings/\n');
  await writeFile(path.join(directory, 'sample.mjs'), 'original\n');
  await git(directory, 'add', '.gitignore', 'sample.mjs');
  await git(directory, 'commit', '--quiet', '-m', 'Temporary test fixture');
  return directory;
}

function fakeGit(directory, status = () => '? sample.mjs\0') {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'git');
    if (args.includes('rev-parse')) return { stdout: `${directory}\n` };
    if (args.includes('status')) return { stdout: status() };
    if (args.includes('diff')) return { stdout: '1\t0\tsample.mjs\0' };
    throw new Error('unexpected_git_command');
  };
  return { execute, calls };
}

test('porcelain v2 parses spaces, renames, conflicts, distances and untracked paths without branch names', () => {
  const result = parseStatus([
    `# branch.oid ${oid}`, '# branch.head private-branch-name', '# branch.ab +2 -3',
    `1 MM N... 100644 100644 100644 ${oid} ${oid} src/two words.mjs`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/new.mjs`, 'src/old.mjs',
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} src/conflict.mjs`,
    '? new\nfile.mjs', '',
  ].join('\0'));
  assert.equal(result.head, oid);
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 3);
  assert.deepEqual(result.counts, { staged: 3, unstaged: 2, untracked: 1, conflicts: 1 });
  assert.equal(result.paths.find((entry) => entry.previousPath)?.previousPath, 'src/old.mjs');
  assert.ok(result.paths.some((entry) => entry.path === 'src/two words.mjs'));
  assert.ok(result.paths.some((entry) => entry.path === 'new?file.mjs'));
  assert.ok(!JSON.stringify(result).includes('private-branch-name'));
});

test('numstat records only numeric diff statistics including binary and rename records', () => {
  assert.deepEqual(parseNumstat(['2\t3\tsource.mjs', '-\t-\timage.bin', '1\t0\t', 'old.mjs', 'new.mjs', ''].join('\0')),
    { files: 3, insertions: 3, deletions: 3, binaryFiles: 1 });
  assert.throws(() => parseNumstat('unexpected output\0'), /invalid_git_diff_summary/);
});

test('known private paths and meeting codes are redacted; metadata is byte-bounded', () => {
  for (const name of ['.env', '.env.local', 'nested/staging.env', 'config.json', '.meeting-mate/chrome/Cookies',
    'recordings/demo.mp4', 'transcripts/demo.txt', 'models/weights.bin', '.venv-transcript/bin/python', 'private.log.1',
    'logs/run.json', 'sound.opus', 'model.gguf', 'ghp_placeholder.mjs']) {
    assert.equal(safePath(name), '[private-path]', name);
  }
  assert.equal(safePath('.env.example'), '.env.example');
  assert.equal(safePath('src/abc-defg-hij.mjs'), 'src/[meeting-code].mjs');
  assert.equal(safePath('/private/file'), '[invalid-path]');
  assert.equal(safePath('../file'), '[invalid-path]');
  assert.ok(Buffer.byteLength(safePath('漢'.repeat(500))) <= 512);
});

test('a real Git checkout exposes only metadata and does not rewrite the index, HEAD, or worktree', async (t) => {
  const directory = await repository(t);
  const marker = 'PRIVATE_FILE_CONTENT_MUST_NOT_APPEAR';
  await writeFile(path.join(directory, 'sample.mjs'), `${marker}\nsecond line\n`);
  await git(directory, 'add', 'sample.mjs');
  await writeFile(path.join(directory, 'sample.mjs'), `${marker}\nsecond line\nthird line\n`);
  await writeFile(path.join(directory, 'untracked.mjs'), marker);
  await writeFile(path.join(directory, '.env'), marker);
  const indexPath = path.join(directory, '.git', 'index');
  const index = await readFile(indexPath);
  const indexInfo = await stat(indexPath);
  const head = (await git(directory, 'rev-parse', 'HEAD')).stdout.trim();
  const result = await collectSnapshot(directory);
  assert.equal(result.state, 'ready');
  assert.equal(result.head, head);
  assert.deepEqual(result.counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
  assert.deepEqual(result.diff.staged, { files: 1, insertions: 2, deletions: 1, binaryFiles: 0 });
  assert.deepEqual(result.diff.unstaged, { files: 1, insertions: 1, deletions: 0, binaryFiles: 0 });
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(!JSON.stringify(result).includes('.env'));
  assert.deepEqual(await readFile(indexPath), index);
  assert.equal((await stat(indexPath)).mtimeMs, indexInfo.mtimeMs);
  assert.equal((await git(directory, 'rev-parse', 'HEAD')).stdout.trim(), head);
  assert.equal(await readFile(path.join(directory, 'untracked.mjs'), 'utf8'), marker);
});

test('uninitialized, unborn, and wrong-root repositories are handled without initialization', async (t) => {
  const directory = await temporary(t);
  assert.equal((await collectSnapshot(directory)).state, 'not_initialized');
  await assert.rejects(access(path.join(directory, '.git')));
  await git(directory, 'init', '--quiet', '-b', 'main');
  const unborn = await collectSnapshot(directory);
  assert.equal(unborn.state, 'ready');
  assert.equal(unborn.head, null);
  await mkdir(path.join(directory, 'nested'));
  assert.equal((await collectSnapshot(path.join(directory, 'nested'))).state, 'wrong_repository');
});

test('Git commands are read-only, bounded in purpose, and exclude refresh writes and external diff processors', async (t) => {
  const directory = await temporary(t);
  const mock = fakeGit(directory);
  await collectSnapshot(directory, mock);
  assert.equal(mock.calls.length, 4);
  for (const { args, options } of mock.calls) {
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.ok(!args.some((arg) => ['add', 'commit', 'push', 'fetch', 'checkout', 'reset'].includes(arg)));
    if (args.includes('diff')) { assert.ok(args.includes('--no-ext-diff')); assert.ok(args.includes('--no-textconv')); }
  }
});

test('Git failures never persist raw stderr or file contents', async (t) => {
  const directory = await temporary(t);
  const secret = 'PRIVATE_STDERR_NOT_FOR_LOGS';
  const result = await recordSnapshot(directory, { execute: async (_command, args) => {
    if (args.includes('rev-parse')) return { stdout: directory };
    throw new Error(secret);
  } });
  assert.equal(result.state, 'error');
  assert.equal(result.error, 'git_summary_failed');
  assert.ok(!JSON.stringify(result).includes(secret));
  const log = await readFile(path.join(directory, '.meeting-mate/repo-changelog.jsonl'), 'utf8');
  assert.ok(!log.includes(secret));
});

test('snapshots are private, history is metadata-only, unchanged checks do not grow history', async (t) => {
  const directory = await temporary(t);
  const mock = fakeGit(directory, () => '? config.json\0? src/file.mjs\0');
  const first = await recordSnapshot(directory, { ...mock, now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(first.changedSincePrevious, true);
  const second = await recordSnapshot(directory, { ...mock, now: () => new Date('2026-01-01T00:30:00Z') });
  assert.equal(second.changedSincePrevious, false);
  assert.notEqual(first.checkedAt, second.checkedAt);
  assert.equal(first.fingerprint, second.fingerprint);
  const files = await readdir(path.join(directory, '.meeting-mate'));
  assert.deepEqual(files.sort(), ['repo-changelog.jsonl', 'repo-status.json']);
  for (const file of files) assert.equal((await stat(path.join(directory, '.meeting-mate', file))).mode & 0o777, 0o600);
  const history = await readFile(path.join(directory, '.meeting-mate/repo-changelog.jsonl'), 'utf8');
  assert.equal(history.trim().split('\n').length, 1);
  assert.ok(!history.includes('config.json'));
  assert.ok(history.includes('[private-path]'));
  assert.ok(history.includes('insertions'));
});

test('history entry and byte caps and path truncation remain bounded', async (t) => {
  const directory = await temporary(t);
  let iteration = 0;
  const mock = fakeGit(directory, () => `? file-${iteration}.mjs\0`);
  for (iteration = 0; iteration <= MAX_HISTORY_ENTRIES; iteration++) await recordSnapshot(directory, mock);
  const historyFile = path.join(directory, '.meeting-mate/repo-changelog.jsonl');
  assert.equal((await readFile(historyFile, 'utf8')).trim().split('\n').length, MAX_HISTORY_ENTRIES);
  const large = fakeGit(directory, () => Array.from({ length: 220 }, (_, i) => `? ${iteration}-${i}-${'漢'.repeat(200)}.mjs\0`).join(''));
  for (iteration = 0; iteration < 8; iteration++) {
    const snapshot = await recordSnapshot(directory, large);
    assert.equal(snapshot.paths.length, 200);
    assert.equal(snapshot.pathsOmitted, 20);
  }
  assert.ok((await stat(historyFile)).size <= MAX_HISTORY_BYTES);
  assert.ok((await stat(path.join(directory, '.meeting-mate/repo-status.json'))).size <= 256 * 1024);
});

test('parallel snapshots skip and stale dead-process locks recover', async (t) => {
  const directory = await temporary(t);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mock = fakeGit(directory);
  const slow = recordSnapshot(directory, { execute: async (...args) => {
    if (args[1].includes('rev-parse')) { entered(); await gate; }
    return mock.execute(...args);
  } });
  await ready;
  assert.deepEqual(await recordSnapshot(directory, mock), { skipped: true, reason: 'watcher_already_running' });
  release();
  await slow;
  await writeFile(path.join(directory, '.meeting-mate/repo-watch.lock'), '2147483647');
  assert.equal((await recordSnapshot(directory, mock)).state, 'ready');
});

test('symlinked state directories and status files are refused without touching targets', async (t) => {
  const directory = await temporary(t);
  const outside = await temporary(t);
  await symlink(outside, path.join(directory, '.meeting-mate'));
  await assert.rejects(recordSnapshot(directory), /unsafe_state_directory/);
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(directory, '.meeting-mate'));
  await mkdir(path.join(directory, '.meeting-mate'));
  const target = path.join(outside, 'private.txt');
  await writeFile(target, 'unchanged');
  await symlink(target, path.join(directory, '.meeting-mate/repo-status.json'));
  await assert.rejects(recordSnapshot(directory, fakeGit(directory)));
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('malformed history is discarded and unknown history fields cannot leak into new reports', async (t) => {
  const directory = await temporary(t);
  const mock = fakeGit(directory);
  await recordSnapshot(directory, mock);
  const file = path.join(directory, '.meeting-mate/repo-changelog.jsonl');
  const event = JSON.parse((await readFile(file, 'utf8')).trim());
  event.untrusted = 'PRIVATE_ADDITIONAL_FIELD';
  event.paths.push({ path: 'config.json', index: 'M', worktree: '.', secret: 'PRIVATE_ADDITIONAL_FIELD' });
  await writeFile(file, `${JSON.stringify(event)}\nmalformed\n`);
  await recordSnapshot(directory, mock);
  const rewritten = await readFile(file, 'utf8');
  assert.ok(!rewritten.includes('PRIVATE_ADDITIONAL_FIELD'));
  assert.ok(!rewritten.includes('config.json'));
  assert.ok(!rewritten.includes('malformed'));
});

test('LaunchAgent defaults to 30 minutes, XML escapes paths, and only runs once commands', () => {
  assert.equal(DEFAULT_INTERVAL_MINUTES, 30);
  const plist = launchdPlist('/tmp/A&B <checkout>', '/tmp/a"b/node');
  assert.match(plist, /StartInterval<\/key><integer>1800/);
  assert.match(plist, /A&amp;B &lt;checkout&gt;/);
  assert.match(plist, /a&quot;b/);
  assert.match(plist, /<string>once<\/string>/);
  assert.ok(!plist.includes('com.meeting-mate.monitor'));
  assert.ok(!plist.includes('KeepAlive'));
  for (const value of [0, -1, 0.5, 1441, NaN]) assert.throws(() => launchdPlist('/tmp/project', '/bin/node', value));
  assert.throws(() => launchdPlist('relative', '/bin/node'));
});

test('generated LaunchAgent passes the native plist validator without installation', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'repo-watch.plist');
  await writeFile(file, launchdPlist('/tmp/A&B <checkout>', '/tmp/a"b/node'));
  const { stdout } = await execute('/usr/bin/plutil', ['-lint', file]);
  assert.match(stdout, /OK/);
});

function launchFixture(directory, home) {
  const calls = [];
  let loaded = false;
  let disabled = false;
  let interval = 1800;
  const execute = async (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('plutil')) {
      if (args.includes('-convert')) return { stdout: JSON.stringify({ Label: LABEL, WorkingDirectory: directory,
        ProgramArguments: ['/bin/node', path.join(directory, 'scripts/repo-watch.mjs'), 'once'], StartInterval: interval }) };
      return { stdout: '' };
    }
    assert.equal(command, '/bin/launchctl');
    if (args[0] === 'print') { if (!loaded) throw new Error('not_loaded'); }
    if (args[0] === 'print-disabled') return { stdout: `"${LABEL}" => ${disabled}` };
    if (args[0] === 'disable') disabled = true;
    if (args[0] === 'enable') disabled = false;
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') loaded = true;
    return { stdout: '' };
  };
  return { options: { directory, home, node: '/bin/node', platform: 'darwin', uid: 501, execute }, calls,
    setInterval(value) { interval = value; } };
}

test('status does not install or write; install/status/stop affect only the dedicated watcher', async (t) => {
  const directory = await temporary(t);
  const home = await temporary(t);
  const fixture = launchFixture(directory, home);
  const before = await manageAgent('status', fixture.options);
  assert.equal(before.installed, false);
  assert.equal(before.loaded, false);
  assert.equal(before.latest, null);
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(directory), []);
  const installed = await manageAgent('install', fixture.options);
  assert.equal(installed.loaded, true);
  assert.equal(installed.intervalSeconds, 1800);
  const plist = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  assert.equal((await stat(plist)).mode & 0o777, 0o600);
  assert.equal((await manageAgent('status', fixture.options)).loaded, true);
  const stopped = await manageAgent('stop', fixture.options);
  assert.equal(stopped.disabled, true);
  assert.equal(stopped.loaded, false);
  assert.equal((await manageAgent('status', fixture.options)).disabled, true);
  await manageAgent('install', { ...fixture.options, intervalMinutes: 60 });
  fixture.setInterval(3600);
  assert.equal((await manageAgent('status', fixture.options)).intervalSeconds, 3600);
  assert.equal((await manageAgent('status', fixture.options)).disabled, false);
  await access(`${plist}.previous`);
  assert.ok(!JSON.stringify(fixture.calls).includes('com.meeting-mate.monitor'));
  assert.ok(fixture.calls.every(({ command }) => ['/bin/launchctl', '/usr/bin/plutil'].includes(command)));
});

test('foreign checkout ownership and unsupported platforms reject service changes', async (t) => {
  const directory = await temporary(t);
  const home = await temporary(t);
  const fixture = launchFixture(directory, home);
  await manageAgent('install', fixture.options);
  fixture.calls.length = 0;
  await assert.rejects(manageAgent('install', { ...fixture.options, directory: path.join(directory, 'other') }), /another_checkout/);
  assert.deepEqual(fixture.calls.map(({ command }) => command), ['/usr/bin/plutil']);
  await assert.rejects(manageAgent('stop', { ...fixture.options, platform: 'linux' }), /requires_macos/);
});

test('CLI help is portable and causes no installation', async () => {
  const { stdout } = await execute(process.execPath, [path.join(sourceRoot, 'scripts/repo-watch.mjs'), '--help']);
  assert.match(stdout, /once\|status\|stop\|install/);
  assert.match(stdout, /No command stages, commits, pushes, or fetches/);
});
