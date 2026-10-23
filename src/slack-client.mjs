const API = 'https://slack.com/api/';
const GET = new Set(['auth.test', 'users.info', 'users.conversations', 'conversations.history', 'conversations.replies', 'chat.getPermalink', 'files.info']);
const POST = new Set(['chat.postMessage', 'assistant.search.context', 'files.getUploadURLExternal', 'files.completeUploadExternal']);

export class SlackError extends Error {
  constructor(method, code, { retryAfter = 0 } = {}) {
    super(`Slack ${method}: ${code}`);
    Object.assign(this, { code, retryAfter });
  }
}

// Tokens are held only in memory; never put them in URLs, state, or errors.
export class SlackClient {
  constructor(token, { fetchImpl = fetch, now = Date.now } = {}) {
    Object.assign(this, { token, fetchImpl, now });
    this.cooldowns = new Map();
  }
  async call(method, args = {}) {
    if (!GET.has(method) && !POST.has(method)) throw new Error('Unsupported Slack operation');
    const remaining = (this.cooldowns.get(method) ?? 0) - this.now();
    if (remaining > 0) throw new SlackError(method, 'ratelimited', { retryAfter: Math.ceil(remaining / 1000) });
    const url = new URL(method, API), get = GET.has(method);
    if (get) for (const [key, value] of Object.entries(args)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: get ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
        ...(get ? {} : { body: JSON.stringify(args) }),
      });
    } catch { throw new SlackError(method, 'connection_failed'); }
    if (response.status === 429) {
      const retryAfter = Math.max(1, Number(response.headers.get('retry-after')) || 60);
      this.cooldowns.set(method, this.now() + retryAfter * 1000);
      throw new SlackError(method, 'ratelimited', { retryAfter });
    }
    if (!response.ok) throw new SlackError(method, `http_${response.status}`);
    let data;
    try { data = await response.json(); } catch { throw new SlackError(method, 'invalid_json'); }
    if (!data.ok) throw new SlackError(method, /^[a-z0-9_]+$/.test(data.error) ? data.error : 'request_failed');
    return data;
  }
  async conversations() {
    const channels = []; let cursor;
    do {
      const page = await this.call('users.conversations', { types: 'public_channel,private_channel,im', exclude_archived: true, limit: 200, cursor });
      channels.push(...(page.channels ?? [])); cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    return channels;
  }
  async messages(channel, { oldest, latest, thread } = {}) {
    const messages = []; let cursor;
    do {
      const page = await this.call(thread ? 'conversations.replies' : 'conversations.history', {
        channel, ...(thread ? { ts: thread } : {}), oldest, latest, inclusive: true, limit: 100, cursor,
      });
      messages.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor;
      if (page.has_more && !cursor) throw new SlackError('messages', 'incomplete_pagination');
    } while (cursor);
    return messages;
  }
  async search(query, after, before, cursor) {
    const page = await this.call('assistant.search.context', {
      query, after, before, cursor, channel_types: ['public_channel', 'private_channel', 'im', 'mpim'],
      content_types: ['messages'], limit: 20, sort: 'timestamp', sort_dir: 'asc',
      disable_semantic_search: true, include_bots: true, include_message_blocks: true,
    });
    return { messages: page.results?.messages ?? [], cursor: page.response_metadata?.next_cursor ?? '' };
  }
  post(channel, thread, text, key) {
    return this.call('chat.postMessage', { channel, thread_ts: thread, text, client_msg_id: key,
      unfurl_links: false, unfurl_media: false, reply_broadcast: false });
  }
  async uploadBytes(uploadUrl, bytes) {
    const url = new URL(uploadUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) throw new Error('Unexpected Slack upload destination');
    let response;
    try {
      response = await this.fetchImpl(url, { method: 'POST', redirect: 'error', body: bytes,
        headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(60_000) });
    } catch { throw new SlackError('upload', 'connection_failed'); }
    if (!response.ok) throw new SlackError('upload', `http_${response.status}`);
  }
}
