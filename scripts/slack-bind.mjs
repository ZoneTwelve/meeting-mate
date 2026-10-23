import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { createApiClient } from '../src/api-client.mjs';
import { bindConfig } from '../src/slack-bind-config.mjs';
import { BindStore } from '../src/slack-bind-store.mjs';
import { SlackClient } from '../src/slack-client.mjs';
import { BindLinear } from '../src/bind-linear.mjs';
import { SlackBinding, safeFailure } from '../src/slack-bind.mjs';
import { commandServer } from '../src/slack-command-server.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('pnpm dev:bind [--check | --once]\nLoads .env.yumi. Receives signed POST /meeting on 127.0.0.1:18007 and polls Slack.\n--check: verify credentials and local connectivity without sending messages or starting a listener.\n--once: process one polling cycle without starting a listener.\nCtrl-C stops only this binder; an existing recording continues. See docs/slack-binding.md.');
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
    const api = createApiClient(local), bot = new SlackClient(config.botToken), user = new SlackClient(config.userToken), linear = new BindLinear(config.linearToken);
    const [botAuth, userAuth] = await Promise.all([bot.call('auth.test'), user.call('auth.test')]);
    if (!botAuth.bot_id || userAuth.bot_id || botAuth.team_id !== userAuth.team_id) throw new Error('Slack tokens must be a bot token and a human user token from the same workspace.');
    const workspace = new URL(botAuth.url);
    if (workspace.protocol !== 'https:' || !workspace.hostname.endsWith('.slack.com') || workspace.username || workspace.password) throw new Error('Unexpected Slack workspace URL.');
    console.log('Slack user and bot authenticated in the same workspace.');
    if (args.includes('--check')) {
      const channels = await bot.conversations();
      console.log(`Bot can read ${channels.length} joined conversations; command access ${config.allowedUsers.length ? 'uses the configured allowlist' : 'defaults to the user-token owner'}.`);
      const probe = await user.search('"meeting-mate"', Math.floor(Date.now() / 1000) - 60, Math.ceil(Date.now() / 1000));
      console.log(`Slack message search available (${probe.messages.length} matches; contents omitted).`);
      await api.health(); console.log('Local recorder API reachable.');
      if (config.linearToken && config.linearTeamId) {
        const data = await linear.query('query($id: String!) { team(id: $id) { id } }', { id: config.linearTeamId });
        if (data?.team?.id !== config.linearTeamId) throw new Error('linear_team_unavailable');
        console.log('Linear team accessible; creating issues still requires human approval.');
      } else console.log('Linear creation not configured; recording and transcript handoff can still run.');
      console.log(`Slash receiver ${config.port ? `configured on port ${config.port}` : 'disabled'}; no listener or messages created by --check.`);
    } else {
      store = new BindStore(config.directory); await store.acquire(); await store.load(botAuth.team_id, botAuth.user_id);
      const binding = new SlackBinding({ config, store, bot, user, api, linear, identity: { bot: botAuth, user: userAuth } });
      if (config.port && !args.includes('--once')) {
        server = commandServer({ signingSecret: config.signingSecret, appId: config.appId, teamId: botAuth.team_id, accept: input => binding.acceptSlash(input) });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
        console.log(`Slash receiver ready: http://127.0.0.1:${config.port}/meeting (signed Slack requests only).`);
      }
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      console.log(`Binding active: channel polling every ${config.pollMs / 1000}s, mention search every ${config.searchMs / 1000}s. Recorder lifecycle is unchanged.`);
      let polledAt = 0;
      do {
        const discover = Date.now() - polledAt >= config.pollMs;
        if (discover) polledAt = Date.now();
        try { await binding.cycle({ discover }); }
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
