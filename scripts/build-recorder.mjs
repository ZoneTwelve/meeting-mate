import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const identity = process.env.MEETING_MATE_CODESIGN_IDENTITY || '-';
const bundle = path.join(root, '.meeting-mate', 'Meeting Mate Recorder.app');
await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.meeting-mate.recorder</string>
<key>CFBundleName</key><string>Meeting Mate Recorder</string>
<key>CFBundleExecutable</key><string>meeting-mate-recorder</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSScreenCaptureUsageDescription</key><string>Record the selected Meet window and its audio to local files.</string>
</dict></plist>`;
const source = path.join(root, 'native', 'Recorder.swift');
const binary = path.join(bundle, 'Contents', 'MacOS', 'meeting-mate-recorder');
const stamp = path.join(root, '.meeting-mate', 'recorder-build.sha256');
const digest = createHash('sha256').update(await readFile(source)).update(plist).update('swiftc -parse-as-library -O').update(identity).digest('hex');
let current = false;
try {
  const samePlist = await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8') === plist;
  const savedDigest = await readFile(stamp, 'utf8').catch(() => null);
  // Adopt the already-built development bundle once, without invalidating its
  // newly granted TCC permission. Future builds use the content digest.
  current = samePlist && (savedDigest === digest || (identity === '-' && !savedDigest && (await stat(binary)).mtimeMs >= (await stat(source)).mtimeMs));
  if (current) execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
} catch { current = false; }
if (current && !process.argv.includes('--force')) {
  await writeFile(stamp, digest);
  console.log(`Recorder unchanged; keeping the existing signed app and its permission.\n${bundle}`);
  process.exit(0);
}
await writeFile(path.join(bundle, 'Contents', 'Info.plist'), plist);
execFileSync('swiftc', ['-parse-as-library', '-O', source, '-o', binary], { stdio: 'inherit', timeout: 120000 });
execFileSync('codesign', ['--force', '--deep', '--sign', identity, '--timestamp=none', '--identifier', 'local.meeting-mate.recorder', bundle], { stdio: 'inherit', timeout: 60000 });
await writeFile(stamp, digest);
console.log(bundle);
console.log('Native app rebuilt. macOS may require removing and re-adding this app in Screen & System Audio Recording.');
