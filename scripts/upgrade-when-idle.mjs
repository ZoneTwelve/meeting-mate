import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { hasActiveMeeting } from '../src/idle.mjs';

const execute = promisify(execFile);
const config = await loadConfig();
const healthUrl = `http://127.0.0.1:${config.healthPort}/healthz`;
const health = async () => {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
  return response.json();
};
const first = await health();
if (!hasActiveMeeting(first)) {
  console.log('No active call; upgrading now.');
} else {
  console.log(`Waiting for active calls to finish before upgrading service ${first.pid}.`);
  let idleSince = null;
  while (true) {
    await delay(2000);
    let status;
    try { status = await health(); }
    catch {
      const service = `gui/${process.getuid()}/com.meeting-mate.monitor`;
      const loaded = await execute('/bin/launchctl', ['print', service]).then(() => true, () => false);
      if (!loaded) { console.log('Service was stopped externally; leaving it stopped.'); process.exit(0); }
      idleSince = null;
      continue;
    }
    if (status.pid !== first.pid) { console.log('Service already restarted; no upgrade needed.'); process.exit(0); }
    if (hasActiveMeeting(status)) { idleSince = null; continue; }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= 10000) break;
  }
}

await execute(process.execPath, ['scripts/launchd.mjs', 'stop']);
for (let attempt = 0; attempt < 60; attempt++) {
  const saved = await fs.readFile(config.statusFile, 'utf8').then((text) => JSON.parse(text)).catch(() => null);
  const stillServing = await health().then(() => true, () => false);
  if (saved?.state === 'stopped' && saved.pid === first.pid && !stillServing) break;
  if (attempt === 59) throw new Error('Timed out waiting for the old recording to finalize');
  await delay(1000);
}
await execute(process.execPath, ['scripts/launchd.mjs', 'install']);
for (let attempt = 0; attempt < 60; attempt++) {
  const status = await health().catch(() => null);
  if (status?.pid && status.pid !== first.pid) {
    console.log(`Service upgraded to PID ${status.pid}; current recording was finalized.`);
    process.exit(0);
  }
  await delay(1000);
}
throw new Error('New service did not become healthy after upgrade');
