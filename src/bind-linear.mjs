export class BindLinear {
  constructor(token, { fetchImpl = fetch } = {}) { this.token = token; this.fetchImpl = fetchImpl; }
  async query(query, variables = {}) {
    if (!this.token) throw new Error('linear_not_configured');
    let response;
    try {
      response = await this.fetchImpl('https://api.linear.app/graphql', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: this.token, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
      });
    } catch { throw new Error('linear_connection_failed'); }
    if (!response.ok) throw new Error(`linear_http_${response.status}`);
    let result;
    try { result = await response.json(); } catch { throw new Error('linear_invalid_response'); }
    if (result.errors?.length) {
      if (result.errors.every(e => e.extensions?.code === 'NOT_FOUND' || /Entity not found|Issue not found/i.test(e.message))) return null;
      throw new Error('linear_graphql_error');
    }
    return result.data;
  }
  async issue(id) {
    const data = await this.query('query($id: String!) { issue(id: $id) { id identifier title url dueDate description team { id } project { id } state { name type } } }', { id });
    return data?.issue ?? null;
  }
  async create(input) {
    const existing = await this.issue(input.id);
    if (existing) {
      if (existing.team?.id !== input.teamId || !existing.description?.includes(`Meeting Mate action: ${input.id}`)) throw new Error('linear_id_conflict');
      return existing;
    }
    const result = await this.query('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url dueDate state { name type } } } }', { input });
    if (!result?.issueCreate?.success || result.issueCreate.issue.id !== input.id) throw new Error('linear_create_unconfirmed');
    return result.issueCreate.issue;
  }
}
