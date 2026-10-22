import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
export const LABEL = 'com.meeting-mate.repo-watch';
export const DEFAULT_INTERVAL_MINUTES = 30;
export const MAX_HISTORY_BYTES = 128 * 1024;
export const MAX_HISTORY_ENTRIES = 100;
const MAX_PATHS = 200;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// Never inherit Git directory overrides or allow prompts, lazy network fetches,
// external diff/text converters, or optional index refresh writes.
function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
}

async function run(command, args, options = {}) {
  return executeFile(command, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...options });
}

function git(execute, directory, args) {
  return execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd: directory, env: gitEnvironment(),
  });
}

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').includes('..')) return '[invalid-path]';
  const parts = value.split('/');
  if (parts.some((part) => part !== '.env.example' && (
    /^(?:\.env(?:\..*)?|.*\.env(?:\..*)?|config\.json|\.meeting-mate|recordings|transcripts|logs|models|\.models|model-cache|\.model-cache|\.cache|\.huggingface|\.hf_cache|node_modules|\.venv(?:-.*)?|venv|__pycache__)$/i.test(part)
    || /\.(?:log(?:\..*)?|out|err|mp4|mov|mkv|webm|wav|m4a|mp3|aac|flac|ogg|opus|aif|aiff|caf|m4v|avi|mpeg|mpg|pt|pth|onnx|safetensors|gguf|ggml|pem|key)$/i.test(part)
    || /(?:github_pat_|gh[pousr]_|sk-|token[=_]|password[=_])/i.test(part)
  ))) return '[private-path]';
  let safe = value.replace(/[a-z]{3}-[a-z]{4}-[a-z]{3}/gi, '[meeting-code]').replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 512);
  while (Buffer.byteLength(safe) > 512) safe = safe.slice(0, -1);
  return safe;
}

export function parseStatus(output) {
  const entries = output.split('\0');
  const result = { head: null, ahead: 0, behind: 0, counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, paths: [], pathsOmitted: 0 };
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i];
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice(13);
      if (/^[a-f0-9]{40,64}$/.test(oid)) result.head = oid;
      continue;
    }
    const distance = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (distance) { result.ahead = Number(distance[1]); result.behind = Number(distance[2]); continue; }
    let entry;
    if (line.startsWith('? ')) {
      result.counts.untracked++;
      entry = { path: safePath(line.slice(2)), index: '?', worktree: '?' };
    } else if (/^[12u] /.test(line)) {
      // v2 ordinary: 8 fields before path; rename: 9; unmerged: 10.
      const prefix = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10;
      const fields = line.split(' ');
      if (fields.length <= prefix || !/^[.MADRCUT?!]{2}$/.test(fields[1])) throw new Error('invalid_git_status');
      const [index, worktree] = fields[1];
      entry = { path: safePath(fields.slice(prefix).join(' ')), index, worktree };
      if (index !== '.') result.counts.staged++;
      if (worktree !== '.') result.counts.unstaged++;
      if (line[0] === 'u') result.counts.conflicts++;
      if (line[0] === '2') { entry.previousPath = safePath(entries[++i]); }
    }
    if (entry) {
      if (result.paths.length < MAX_PATHS) result.paths.push(entry);
      else result.pathsOmitted++;
    }
  }
  result.paths.sort((a, b) => a.path.localeCompare(b.path) || a.index.localeCompare(b.index));
  return result;
}

export function parseNumstat(output) {
  const fields = output.split('\0');
  const result = { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 };
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) throw new Error('invalid_git_diff_summary');
    result.files++;
    if (match[1] === '-' || match[2] === '-') result.binaryFiles++;
    else { result.insertions += Number(match[1]); result.deletions += Number(match[2]); }
    if (!match[3]) i += 2; // -z rename records carry old/new paths separately.
  }
  return result;
}

export async function collectSnapshot(directory, { execute = run, now = () => new Date() } = {}) {
  const snapshot = { schemaVersion: 1, checkedAt: now().toISOString(), state: 'not_initialized', head: null, ahead: 0, behind: 0,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, paths: [], pathsOmitted: 0, diff: null };
  let top;
  try { top = (await git(execute, directory, ['rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch { return snapshot; }
  if (await realpath(top) !== await realpath(directory)) return { ...snapshot, state: 'wrong_repository' };
  try {
    const [status, staged, unstaged] = await Promise.all([
      git(execute, directory, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignore-submodules=all']),
      git(execute, directory, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']),
      git(execute, directory, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']),
    ]);
    return { ...snapshot, state: 'ready', ...parseStatus(status.stdout), diff: { staged: parseNumstat(staged.stdout), unstaged: parseNumstat(unstaged.stdout) } };
  } catch { return { ...snapshot, state: 'error', error: 'git_summary_failed' }; }
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_state_directory');
}

async function readSmall(file, limit) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('unsafe_state_file');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function writeAtomic(file, content) {
  const old = await lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (old && (!old.isFile() || old.isSymbolicLink())) throw new Error('unsafe_state_file');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

function historyEvent(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '') || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  if (!['ready', 'not_initialized', 'wrong_repository', 'error'].includes(value.state)) return null;
  return {
    checkedAt: new Date(value.checkedAt).toISOString(), fingerprint: value.fingerprint, state: value.state,
    head: /^[a-f0-9]{40,64}$/.test(value.head ?? '') ? value.head : null,
    counts: Object.fromEntries(['staged', 'unstaged', 'untracked', 'conflicts'].map((key) => [key, number(value.counts?.[key])])),
    diff: value.diff ? Object.fromEntries(['staged', 'unstaged'].map((kind) => [kind,
      Object.fromEntries(['files', 'insertions', 'deletions', 'binaryFiles'].map((key) => [key, number(value.diff?.[kind]?.[key])]))])) : null,
    paths: Array.isArray(value.paths) ? value.paths.slice(0, 50).map((entry) => ({ path: safePath(entry.path),
      index: /^[.MADRCUT?!]$/.test(entry.index) ? entry.index : '?', worktree: /^[.MADRCUT?!]$/.test(entry.worktree) ? entry.worktree : '?' })) : [],
    pathsOmitted: number(value.pathsOmitted) + Math.max(0, (value.paths?.length ?? 0) - 50),
  };
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await lstat(file);
      if (!old.isFile() || old.isSymbolicLink()) throw new Error('unsafe_lock_file');
      const pid = Number(await readSmall(file, 32));
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; }
      catch (failure) { if (failure.code !== 'ESRCH') return false; }
      const current = await lstat(file);
      if (current.ino !== old.ino) return false;
      await unlink(file); // Only a stale watcher-owned lock, never project data.
    }
  }
  return false;
}

export async function recordSnapshot(directory, options = {}) {
  const stateDirectory = path.join(directory, '.meeting-mate');
  await privateDirectory(stateDirectory);
  const lock = path.join(stateDirectory, 'repo-watch.lock');
  if (!await acquireLock(lock)) return { skipped: true, reason: 'watcher_already_running' };
  try {
    const snapshot = await collectSnapshot(directory, options);
    const { checkedAt, ...content } = snapshot;
    snapshot.fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const statusFile = path.join(stateDirectory, 'repo-status.json');
    const historyFile = path.join(stateDirectory, 'repo-changelog.jsonl');
    const previous = await readSmall(statusFile, MAX_SNAPSHOT_BYTES);
    let fingerprint;
    try { fingerprint = JSON.parse(previous)?.fingerprint; } catch { /* Replace malformed watcher state, not project files. */ }
    const historyText = await readSmall(historyFile, MAX_HISTORY_BYTES);
    let events = [];
    for (const line of (historyText ?? '').split('\n').filter(Boolean)) {
      try { const event = historyEvent(JSON.parse(line)); if (event) events.push(event); } catch { /* Drop malformed metadata entries. */ }
    }
    snapshot.changedSincePrevious = snapshot.fingerprint !== fingerprint;
    if (snapshot.changedSincePrevious) events.push(historyEvent(snapshot));
    events = events.slice(-MAX_HISTORY_ENTRIES);
    let history = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    while (Buffer.byteLength(history) > MAX_HISTORY_BYTES && events.length) {
      events.shift(); history = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    }
    await writeAtomic(historyFile, history);
    await writeAtomic(statusFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
  } finally { await unlink(lock).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export function launchdPlist(directory, node, intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('interval_minutes_must_be_1_to_1440');
  if (!path.isAbsolute(directory) || !path.isAbsolute(node)) throw new Error('launchd_paths_must_be_absolute');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(directory, 'scripts/repo-watch.mjs'))}</string><string>once</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
<key>StartInterval</key><integer>${intervalMinutes * 60}</integer>
<key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}

export async function manageAgent(action, { directory = root, node = process.execPath, home = homedir(), platform = process.platform,
  uid = process.getuid?.(), intervalMinutes = DEFAULT_INTERVAL_MINUTES, execute = run } = {}) {
  if (!['install', 'status', 'stop'].includes(action)) throw new Error('unknown_action');
  if (platform !== 'darwin' || !Number.isSafeInteger(uid)) throw new Error('launchagent_requires_macos');
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const folder = path.join(home, 'Library', 'LaunchAgents');
  const plist = path.join(folder, `${LABEL}.plist`);
  const existing = await readSmall(plist, 32768);
  let config = null;
  if (existing !== null) {
    try { config = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout); }
    catch { throw new Error('invalid_existing_watcher_plist'); }
    if (config.Label !== LABEL || config.WorkingDirectory !== directory || config.ProgramArguments?.[1] !== path.join(directory, 'scripts/repo-watch.mjs')) {
      throw new Error('watcher_belongs_to_another_checkout');
    }
  }
  const loaded = await execute('/bin/launchctl', ['print', service]).then(() => true, () => false);
  if (action === 'status') {
    const disabledText = await execute('/bin/launchctl', ['print-disabled', domain]).then((result) => result.stdout, () => '');
    const disabled = new RegExp(`"${LABEL.replaceAll('.', '\\.')}"\\s*=>\\s*true`).test(disabledText);
    const saved = await readSmall(path.join(directory, '.meeting-mate', 'repo-status.json'), MAX_SNAPSHOT_BYTES);
    let latest = null;
    try { latest = historyEvent(JSON.parse(saved)); } catch { /* Report corrupt or absent state without printing it. */ }
    return { label: LABEL, installed: existing !== null, loaded, disabled, intervalSeconds: number(config?.StartInterval) || null, latest };
  }
  // Never touch another checkout's loaded service when its plist is unavailable.
  if (loaded && existing === null) throw new Error('loaded_watcher_has_no_owned_plist');
  if (action === 'stop') {
    await execute('/bin/launchctl', ['disable', service]);
    if (loaded) await execute('/bin/launchctl', ['bootout', service]);
    return { label: LABEL, installed: existing !== null, loaded: false, disabled: true };
  }
  const document = launchdPlist(directory, node, intervalMinutes);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (existing !== null) await writeAtomic(`${plist}.previous`, existing);
  await writeAtomic(plist, document);
  await chmod(plist, 0o600);
  await execute('/usr/bin/plutil', ['-lint', plist]);
  if (loaded) await execute('/bin/launchctl', ['bootout', service]);
  await execute('/bin/launchctl', ['enable', service]);
  await execute('/bin/launchctl', ['bootstrap', domain, plist]);
  return { label: LABEL, installed: true, loaded: true, disabled: false, intervalSeconds: intervalMinutes * 60 };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    console.log('Usage: pnpm exec node scripts/repo-watch.mjs once|status|stop|install [--interval-minutes 30]\nOnly install starts periodic local checks. No command stages, commits, pushes, or fetches.');
    return;
  }
  const [action, flag, value, ...extra] = args;
  if (!['once', 'status', 'stop', 'install'].includes(action) || extra.length
      || (flag !== undefined && (action !== 'install' || flag !== '--interval-minutes' || !/^\d+$/.test(value ?? '')))) throw new Error('invalid_arguments');
  const result = action === 'once' ? await recordSnapshot(root) : await manageAgent(action, { intervalMinutes: value === undefined ? DEFAULT_INTERVAL_MINUTES : Number(value) });
  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'error' || result.state === 'wrong_repository') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    // Never forward Git/launchctl stderr, paths from errors, or environment values.
    const safe = /^(?:[a-z][a-z0-9_]+)$/.test(error.message) ? error.message : 'repo_watch_failed';
    console.error(safe); process.exitCode = 1;
  });
}
