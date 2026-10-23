import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { createApiClient } from '../src/api-client.mjs';
import { bindConfig } from '../src/slack-bind-config.mjs';
import { BindStore } from '../src/slack-bind-store.mjs';
import { SlackClient } from '../src/slack-client.mjs';
import { SlackBinding, safeFailure } from '../src/slack-bind.mjs';
import { commandServer } from '../src/slack-command-server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('pnpm dev:bind [--check | --once]\nLoads .env.yumi. Receives signed POST /meeting and /meeting-stop on 127.0.0.1:18007. Replies only through the slash HTTP response; no polling or proactive messages.\n--check: verify credentials and local connectivity without sending messages or starting a listener.\n--once: process persisted slash commands once without starting a listener.\nCtrl-C stops only this binder; recording and transcription continue. See docs/slack-binding.md.');
} else if (args.some(arg => !['--check', '--once'].includes(arg)) || args.length > 1) {
  console.error('Use --help for supported arguments.'); process.exitCode = 1;
} else {
  let store, server; const abort = new AbortController();
  const stop = () => abort.abort();
  try {
    const config = await bindConfig();
    let local;
    try { local = await loadConfig(); } catch { throw new Error('Local config could not be loaded; check config.json and .env.'); }
    if (config.port && config.port === local.healthPort) throw new Error('Slack listener must use a different port from the recorder.');
    const api = createApiClient(local), bot = new SlackClient(config.botToken);
    const botAuth = await bot.call('auth.test');
    if (!botAuth.bot_id || !botAuth.team_id || !botAuth.user_id) throw new Error('Slack bot identity could not be verified.');
    let userAuth;
    if (config.meetingAccess === 'owner' && !config.allowedUsers.length) {
      userAuth = await new SlackClient(config.userToken).call('auth.test');
      if (userAuth.bot_id || !userAuth.user_id || botAuth.team_id !== userAuth.team_id) throw new Error('Owner token must be a human user from the same Slack workspace.');
    }
    console.log(`Slack bot authenticated; meeting access: ${config.meetingAccess}.`);
    if (args.includes('--check')) {
      await api.health(); console.log('Local recorder API reachable.');
      console.log('Slash-only mode: no message reads, posts, uploads, handoff, or Linear follow-ups.');
      console.log(`Slash receiver ${config.port ? `configured on port ${config.port}` : 'disabled'}; no listener or messages created by --check.`);
    } else {
      store = new BindStore(config.directory); await store.acquire(); await store.load(botAuth.team_id, botAuth.user_id);
      const binding = new SlackBinding({ config, store, api, identity: { bot: botAuth, user: userAuth } });
      await binding.prepare();
      if (config.port && !args.includes('--once')) {
        server = commandServer({ signingSecret: config.signingSecret, appId: config.appId, teamId: botAuth.team_id, accept: input => binding.acceptSlash(input) });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
        console.log(`Slash receiver ready: http://127.0.0.1:${config.port}/meeting and /meeting-stop (signed Slack requests only; meeting access: ${config.meetingAccess}).`);
      }
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      console.log('Slash-only binding active: ephemeral command replies only. Recording and transcription run independently.');
      do {
        try { await binding.cycle(); }
        catch (error) { console.error(`Binding cycle deferred: ${safeFailure(error)}`); }
        if (args.includes('--once') || abort.signal.aborted) break;
        await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
      } while (!abort.signal.aborted);
    }
  } catch (error) {
    // Configuration errors above are fixed strings; remote errors never include bodies.
    console.error(error.code || error.message?.startsWith('linear_') ? safeFailure(error) : error.message);
    process.exitCode = 1;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await store?.release();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
