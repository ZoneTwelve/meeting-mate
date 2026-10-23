import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberate, reviewed allowlist. Never glob the checkout or package runtime data.
export const RELEASE_FILES = Object.freeze([
  'package.json', 'pnpm-lock.yaml', '.env.example', '.gitignore', 'config.example.json', 'README.md', 'AGENTS.md', 'Todo.md',
  'requirements-transcript.txt', 'bin/meeting-mate.mjs', 'native/Recorder.swift',
  'src/api-client.mjs', 'src/browser.mjs', 'src/cdp.mjs', 'src/config.mjs',
  'src/control-server.mjs', 'src/diagnostics.mjs', 'src/idle.mjs', 'src/index.mjs',
  'src/mcp.mjs', 'src/meet-page.mjs', 'src/monitor.mjs', 'src/openapi.mjs',
  'src/recorder.mjs', 'src/recording-tests.mjs', 'src/recordings.mjs', 'src/schedule.mjs',
  'src/transcript-format.mjs', 'src/transcripts.mjs',
  'src/bind-linear.mjs', 'src/slack-client.mjs', 'src/slack-command-server.mjs',
  'src/slack-bind.mjs', 'src/slack-bind-config.mjs', 'src/slack-bind-commands.mjs', 'src/slack-bind-store.mjs',
  'scripts/build-recorder.mjs', 'scripts/check.mjs', 'scripts/doctor.mjs',
  'scripts/install-launchd.sh', 'scripts/join-now.mjs', 'scripts/launchd.mjs',
  'scripts/package-release.mjs', 'scripts/prepare-camera.mjs', 'scripts/repo-watch.mjs',
  'scripts/smoke.mjs', 'scripts/test-mcp-live.mjs', 'scripts/test-transcript-live.mjs',
  'scripts/slack-bind.mjs', 'docs/slack-binding.md',
  'scripts/transcribe.py', 'scripts/transcript-setup.mjs', 'scripts/upgrade-when-idle.mjs',
  'docs/api.md', 'docs/mcp.md', 'docs/releases.md', 'docs/repository.md', 'docs/requirements.md', 'docs/test-plan.md', 'docs/transcript.md',
]);
const NATIVE_FILES = ['Contents/Info.plist', 'Contents/MacOS/meeting-mate-recorder', 'Contents/_CodeSignature/CodeResources'];
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = (name) => name === 'bin/meeting-mate.mjs' || name === 'scripts/install-launchd.sh' || name === 'Contents/MacOS/meeting-mate-recorder';

async function safeRead(base, relative) {
  const parts = relative.split('/');
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Refusing non-regular release input: ${relative}`);
    }
  }
  return readFile(current);
}

// USTAR + gzip: stable ordering, modes, ownership, timestamps; no host metadata.
export function tarGzip(entries, epoch) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    if (Buffer.byteLength(name) > 100) throw new Error('Release path exceeds USTAR limit');
    const header = Buffer.alloc(512);
    const octal = (value, offset, size) => {
      const text = value.toString(8);
      if (text.length >= size) throw new Error('Release field exceeds USTAR limit');
      header.write(`${text.padStart(size - 1, '0')}\0`, offset, size, 'ascii');
    };
    header.write(name, 0, 100, 'utf8');
    octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(data.length, 124, 12); octal(epoch, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
}

function crc32(data) {
  let result = 0xffffffff;
  for (const byte of data) {
    result ^= byte;
    for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (0xedb88320 & -(result & 1));
  }
  return (result ^ 0xffffffff) >>> 0;
}

// Stored ZIP preserves the signed bytes; no zip executable, xattrs, or re-signing.
export function zip(entries, epoch) {
  const date = new Date(Math.max(315532800, epoch) * 1000); // ZIP minimum: 1980-01-01 UTC.
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const local = [], central = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const encoded = Buffer.from(name);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(encoded.length, 28); directory.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, encoded);
    offset += header.length + encoded.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packageRelease({ kind = 'cli', directory = root, output, arch = process.arch, epoch = 0 } = {}) {
  if (!['cli', 'native'].includes(kind)) throw new Error('kind must be cli or native');
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new Error('SOURCE_DATE_EPOCH must be an integer from 0 to 4294967295');
  if (kind === 'native' && (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || arch !== process.arch)) {
    throw new Error('Native packaging must run on the matching arm64/x64 macOS runner');
  }
  const base = await realpath(directory);
  const manifest = JSON.parse(await safeRead(base, 'package.json'));
  if (manifest.name !== 'meeting-mate' || manifest.private !== true || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) {
    throw new Error('Expected private meeting-mate package with a release version');
  }
  const version = manifest.version;
  const file = kind === 'cli' ? `meeting-mate-cli-v${version}.tgz` : `MeetingMateRecorder-v${version}-macos-${arch}.zip`;
  const entries = [];
  for (const name of [...(kind === 'cli' ? RELEASE_FILES : NATIVE_FILES)].sort()) {
    const relative = kind === 'cli' ? name : `.meeting-mate/Meeting Mate Recorder.app/${name}`;
    const data = await safeRead(base, relative);
    entries.push({ name: `${kind === 'cli' ? 'package' : 'Meeting Mate Recorder.app'}/${name}`, data, mode: executable(name) ? 0o755 : 0o644 });
  }
  const data = kind === 'cli' ? tarGzip(entries, epoch) : zip(entries, epoch);
  const destination = path.resolve(output ?? path.join(base, '.meeting-mate/releases'));
  await mkdir(destination, { recursive: true });
  const filename = path.join(destination, file);
  const digest = createHash('sha256').update(data).digest('hex');
  // Never silently replace a previous release artifact.
  await writeFile(filename, data, { flag: 'wx', mode: 0o644 });
  await writeFile(`${filename}.sha256`, `${digest}  ${file}\n`, { flag: 'wx', mode: 0o644 });
  return { artifact: filename, sha256: digest, files: entries.length, kind, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--kind', '--out', '--arch'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]] !== undefined) {
        throw new Error('Usage: node scripts/package-release.mjs --kind cli|native [--out directory] [--arch arm64|x64]');
      }
      options[args[i]] = args[i + 1];
    }
    console.log(JSON.stringify(await packageRelease({ kind: options['--kind'], output: options['--out'], arch: options['--arch'],
      epoch: Number(process.env.SOURCE_DATE_EPOCH ?? 0) }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
