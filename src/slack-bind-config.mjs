import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { root } from './config.mjs';

export async function bindConfig(directory = root, inherited = process.env) {
  const envFile = path.resolve(directory, inherited.SLACK_BIND_ENV ?? '.env.yumi');
  let loaded;
  try { loaded = parseEnv(await readFile(envFile, 'utf8')); }
  catch { throw new Error('Cannot read Slack env file; create .env.yumi or set SLACK_BIND_ENV.'); }
  const env = { ...loaded, ...inherited };
  const userToken = env.USER_OAUTH_TOKEN ?? env.SLACK_USER_TOKEN;
  const botToken = env.BOT_USER_OAUTH_TOKEN ?? env.SLACK_BOT_TOKEN;
  if (!userToken || !botToken) throw new Error('Set USER_OAUTH_TOKEN and BOT_USER_OAUTH_TOKEN in .env.yumi.');
  const port = Number(env.SLACK_BIND_PORT ?? 18007);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SLACK_BIND_PORT must be 0 (disabled) or a valid port.');
  const signingSecret = env.SIGNING_SECRET ?? env.SLACK_SIGNING_SECRET;
  const appId = env.APP_ID ?? env.SLACK_APP_ID;
  if (port && (!signingSecret || !/^A[A-Z0-9]+$/.test(appId ?? ''))) throw new Error('Set SIGNING_SECRET and APP_ID for /meeting, or SLACK_BIND_PORT=0 for polling only.');
  const meetingAccess = env.SLACK_BIND_MEETING_ACCESS ?? 'workspace';
  if (!['workspace', 'owner'].includes(meetingAccess)) throw new Error('SLACK_BIND_MEETING_ACCESS must be workspace or owner.');
  const seconds = (key, fallback, min) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > 86400) throw new Error(`${key} is outside the supported seconds range.`);
    return value * 1000;
  };
  const ids = (key, pattern) => {
    const values = (env[key] ?? '').split(',').map(v => v.trim()).filter(Boolean);
    if (values.some(v => !pattern.test(v))) throw new Error(`${key} contains an invalid ID.`);
    return values;
  };
  let linear = { ...env };
  if (env.SLACK_BIND_LINEAR_ENV) {
    try { linear = { ...parseEnv(await readFile(path.resolve(directory, env.SLACK_BIND_LINEAR_ENV), 'utf8')), ...env }; }
    catch { throw new Error('Cannot read SLACK_BIND_LINEAR_ENV.'); }
  }
  return {
    directory, userToken, botToken, port, signingSecret, appId, meetingAccess,
    pollMs: seconds('SLACK_BIND_POLL_SECONDS', 30, 15),
    searchMs: seconds('SLACK_BIND_SEARCH_SECONDS', 300, 60),
    remindMs: seconds('SLACK_BIND_REMIND_SECONDS', 86400, 300),
    channelIds: ids('SLACK_BIND_CHANNEL_IDS', /^[CDG][A-Z0-9]+$/),
    allowedUsers: ids('SLACK_BIND_ALLOWED_USER_IDS', /^[UW][A-Z0-9]+$/),
    handoff: env.SLACK_BIND_HANDOFF !== 'false',
    linearToken: linear.LINEAR_TOKEN ?? linear.LINEAR_API_KEY,
    linearTeamId: env.SLACK_BIND_LINEAR_TEAM_ID,
    linearProjectId: env.SLACK_BIND_LINEAR_PROJECT_ID,
  };
}
