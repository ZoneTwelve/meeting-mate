import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, root } from '../src/config.mjs';

const execute = promisify(execFile);
const label = 'com.meeting-mate.monitor';
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
export function launchdPlist(directory, node, envPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(directory, 'src/index.mjs'))}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(directory, '.meeting-mate/launchd.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(directory, '.meeting-mate/launchd.err.log'))}</string>
</dict></plist>\n`;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This service requires macOS');
  const action = process.argv[2];
  if (!['install', 'stop'].includes(action)) throw new Error('Usage: launchd.mjs install|stop');
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${label}`;
  const loaded = await execute('/bin/launchctl', ['print', service]).then(() => true, () => false);
  if (action === 'stop') {
    if (loaded) await execute('/bin/launchctl', ['bootout', service]);
    console.log(loaded ? 'Meeting Mate stopped; the active recording is being finalized.' : 'Meeting Mate is not loaded.');
    return;
  }
  const config = await loadConfig();
  await access(config.chromePath);
  await access(config.recorderPath);
  if (config.cameraIndicator) await access(config.cameraFile);
  const directory = path.join(homedir(), 'Library', 'LaunchAgents');
  const plist = path.join(directory, `${label}.plist`);
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, '.meeting-mate'), { recursive: true, mode: 0o700 });
  await copyFile(plist, `${plist}.${Date.now()}.backup`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(plist, launchdPlist(root, process.execPath, `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`), { mode: 0o600 });
  await execute('/usr/bin/plutil', ['-lint', plist]);
  if (loaded) await execute('/bin/launchctl', ['bootout', service]);
  // launchctl may need a moment to remove the old service after bootout.
  let bootstrapError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await execute('/bin/launchctl', ['bootstrap', domain, plist]); bootstrapError = null; break; }
    catch (error) {
      bootstrapError = error;
      if (!String(error.stderr).includes('Bootstrap failed: 5')) break;
      await delay(250);
    }
  }
  if (bootstrapError) throw bootstrapError;
  console.log(`Installed ${plist}\nHealth: http://127.0.0.1:${config.healthPort}/healthz`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
