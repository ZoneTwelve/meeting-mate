import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from '../src/config.mjs';

// Explicit live test: uses the service's resource lock, never joins a Meet.
const client = new Client({ name: 'meeting-mate-live-validation', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp.mjs')], stderr: 'inherit' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const status = await call('meet_status');
  console.log(JSON.stringify({ phase: 'connected', tools: tools.length, serviceState: status.health.state }));
  const diagnostics = await call('recorder_diagnostics');
  if (!diagnostics.ok) throw new Error(`Recorder diagnostics failed: ${JSON.stringify(diagnostics)}`);
  const job = await call('recording_test_start', { idempotencyKey: `live-${randomUUID()}` });
  console.log(JSON.stringify({ phase: 'recording_test_started', id: job.id }));
  const deadline = Date.now() + 120000;
  let result;
  do {
    await delay(1000);
    result = await call('recording_test_status', { id: job.id });
  } while (result.state === 'running' && Date.now() < deadline);
  if (result.state !== 'passed') throw new Error(`Live recording test did not pass: ${JSON.stringify(result)}`);
  const report = { verifiedAt: new Date().toISOString(), tools, jobId: job.id, state: result.state, report: result.report };
  await mkdir(path.join(root, '.meeting-mate'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, '.meeting-mate/mcp-live-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
