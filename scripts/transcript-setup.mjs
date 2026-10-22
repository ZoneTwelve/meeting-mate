import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(root, '.meeting-mate');
const models = path.join(state, 'models');
const venv = path.join(state, 'transcript-venv');
const python = path.join(venv, 'bin', 'python');
const revision = '536b0662742c02347bc0e980a01041f333bce120';
const github = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const segmentation = 'sherpa-onnx-pyannote-segmentation-3-0';
const embedding = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
const downloads = [
  { file: 'faster-whisper-small/config.json', bytes: 2370, gitSha: 'e5047537059bd8f182d9ca64c470201585015187' },
  { file: 'faster-whisper-small/model.bin', bytes: 483546902, sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671' },
  { file: 'faster-whisper-small/tokenizer.json', bytes: 2203239, gitSha: '7818adb6de9fa3064d3ff81226fdd675be1f6344' },
  { file: 'faster-whisper-small/vocabulary.txt', bytes: 459861, gitSha: 'c9074644d9d1205686f16d411564729461324b75' },
  { file: `${segmentation}.tar.bz2`, bytes: 6958444, sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488', url: `${github}/speaker-segmentation-models/${segmentation}.tar.bz2` },
  { file: embedding, bytes: 39593761, sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b', url: `${github}/speaker-recongition-models/${embedding}` },
];
const env = {
  ...process.env,
  PATH: [process.env.PATH, path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(path.delimiter),
  HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false',
};
const required = [
  'faster-whisper-small/config.json', 'faster-whisper-small/model.bin',
  'faster-whisper-small/tokenizer.json', 'faster-whisper-small/vocabulary.txt',
  `${segmentation}/model.onnx`, embedding,
];
let currentChild;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  controller.abort(new Error(`Setup interrupted by ${signal}`));
  currentChild?.kill('SIGTERM');
});

async function run(command, args, timeoutMs = 600_000, capture = false) {
  controller.signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', capture ? 'pipe' : process.stderr, process.stderr], signal: controller.signal });
    currentChild = child;
    const chunks = [];
    let length = 0;
    if (capture) child.stdout.on('data', (data) => {
      length += data.length;
      if (length > 10 * 1024 ** 2) child.kill('SIGKILL');
      else chunks.push(data);
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      currentChild = undefined;
      if (code === 0 && length <= 10 * 1024 ** 2 && !timedOut) resolve(Buffer.concat(chunks));
      else reject(new Error(`${path.basename(command)} failed (${timedOut ? 'timeout' : signal ?? code})`));
    });
  });
}

async function hashFile(filename, algorithm = 'sha256', prefix) {
  const hash = createHash(algorithm);
  if (prefix) hash.update(prefix);
  for await (const data of createReadStream(filename)) hash.update(data);
  return hash.digest('hex');
}

async function validFile(filename, item) {
  const stat = await fs.lstat(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`Refusing non-regular model file: ${filename}`);
  if (stat.size !== item.bytes) return false;
  if (item.sha256) return await hashFile(filename) === item.sha256;
  if (item.gitSha) return await hashFile(filename, 'sha1', `blob ${item.bytes}\0`) === item.gitSha;
  return true;
}

async function directory(filename) {
  await fs.mkdir(filename, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(filename)).isDirectory()) throw new Error(`Refusing symlink/non-directory: ${filename}`);
}

async function download(item) {
  const destination = path.join(models, item.file);
  await directory(path.dirname(destination));
  if (await validFile(destination, item)) return;
  const url = item.url ?? `https://huggingface.co/Systran/faster-whisper-small/resolve/${revision}/${path.basename(item.file)}`;
  console.error(`Downloading ${item.file} (${(item.bytes / 1024 ** 2).toFixed(1)} MiB)`);
  const partial = `${destination}.${randomUUID()}.part`;
  let handle;
  try {
    const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} (${item.file})`);
    handle = await fs.open(partial, 'wx', 0o600);
    let bytes = 0;
    for await (const data of response.body) {
      bytes += data.length;
      if (bytes > item.bytes) throw new Error(`Unexpected model size: ${item.file}`);
      await handle.writeFile(data);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!await validFile(partial, item)) throw new Error(`Model integrity check failed: ${item.file}`);
    await fs.rename(partial, destination);
  } finally {
    await handle?.close();
    await fs.unlink(partial).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function inspect() {
  const missing = [];
  for (const filename of [python, ...required.map((name) => path.join(models, name))]) {
    if (!await fs.stat(filename).then((s) => s.isFile()).catch(() => false)) missing.push(filename);
  }
  return { ready: missing.length === 0, python, models, missing };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Usage: node scripts/transcript-setup.mjs [--check]');
  if (process.argv[2] === '--check') {
    const result = await inspect();
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This pinned local setup is tested on macOS arm64 only.');
  await directory(state);
  await directory(models);
  const disk = await fs.statfs(models);
  if (disk.bavail * disk.bsize < 2.5 * 1024 ** 3) throw new Error('Need at least 2.5 GiB free before installing the local transcript engine.');
  if (!await fs.stat(python).then(() => true).catch(() => false)) {
    await run('uv', ['venv', '--python', '3.12', venv]);
  }
  await run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Transcript venv must use Python 3.12"']);
  await run('uv', ['pip', 'install', '--python', python, '--no-cache', '--only-binary', ':all:', '--requirement', path.join(root, 'requirements-transcript.txt')]);
  for (const item of downloads) await download(item);
  await directory(path.join(models, segmentation));
  // Extract only these exact members to explicit paths; never unpack arbitrary archive paths.
  for (const member of ['model.onnx', 'LICENSE', 'README.md']) {
    const data = await run('/usr/bin/tar', ['-xOf', path.join(models, `${segmentation}.tar.bz2`), `${segmentation}/${member}`], 60_000, true);
    const destination = path.join(models, segmentation, member);
    const partial = `${destination}.${randomUUID()}.part`;
    try {
      await fs.writeFile(partial, data, { flag: 'wx', mode: 0o600 });
      await fs.rename(partial, destination);
    } finally {
      await fs.unlink(partial).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  await run(python, ['-c', 'import faster_whisper, sherpa_onnx, ctranslate2; assert "int8" in ctranslate2.get_supported_compute_types("cpu"); print("Local CPU inference imports verified", file=__import__("sys").stderr)']);
  const hashes = {};
  for (const name of required) hashes[name] = await hashFile(path.join(models, name));
  const result = { ...await inspect(), whisperRevision: revision, sha256: hashes };
  await fs.writeFile(path.join(models, 'transcript-models.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(`Transcript setup: ${error.message}`);
  process.exitCode = 1;
});
