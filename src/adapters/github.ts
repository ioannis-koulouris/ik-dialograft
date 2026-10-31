export type RouteLabel = 'auto-implement' | 'needs-human';
export const ROUTE_LABELS: RouteLabel[] = ['auto-implement', 'needs-human'];

export interface ChangedFile { path: string; content: string | null }

export interface GitHubPort {
  headCommit(branch?: string): Promise<string>;
  listFiles(commit: string): Promise<{ path: string; sha: string; size: number; type: string }[]>;
  readBlob(sha: string): Promise<string>;
  /** Creates the issue or updates the existing one; labels are mutually exclusive. */
  upsertIssue(input: { number?: number; title: string; body: string; label: RouteLabel }): Promise<{ number: number; url: string }>;
  createDraftPr(input: { baseCommit: string; branch: string; title: string; body: string; files: ChangedFile[] }): Promise<{ number: number; url: string }>;
}

/** Minimal GitHub REST client. Uses the git data API so no credentials ever touch a working tree. */
export class GitHubClient implements GitHubPort {
  constructor(private repo: string, private token: string, private fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async headCommit(branch = 'main') {
    return (await this.call<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`)).object.sha;
  }

  async listFiles(commit: string) {
    const c = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${commit}`);
    const t = await this.call<{ truncated: boolean; tree: { path: string; sha: string; size: number; type: string }[] }>('GET', `/git/trees/${c.tree.sha}?recursive=1`);
    if (t.truncated) throw new Error('tree truncated');
    return t.tree;
  }

  async readBlob(sha: string) {
    const b = await this.call<{ content: string; encoding: string }>('GET', `/git/blobs/${sha}`);
    return Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }

  async upsertIssue(input: { number?: number; title: string; body: string; label: RouteLabel }) {
    const labels = [input.label, 'feature-request'];
    const issue = input.number
      ? await this.call<{ number: number; html_url: string }>('PATCH', `/issues/${input.number}`, { title: input.title, body: input.body, labels })
      : await this.call<{ number: number; html_url: string }>('POST', '/issues', { title: input.title, body: input.body, labels });
    return { number: issue.number, url: issue.html_url };
  }

  async createDraftPr(input: { baseCommit: string; branch: string; title: string; body: string; files: ChangedFile[] }) {
    const base = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${input.baseCommit}`);
    const tree = [];
    for (const f of input.files) {
      if (f.content === null) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await this.call<{ sha: string }>('POST', '/git/blobs', { content: Buffer.from(f.content).toString('base64'), encoding: 'base64' });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.call<{ sha: string }>('POST', '/git/trees', { base_tree: base.tree.sha, tree });
    const commit = await this.call<{ sha: string }>('POST', '/git/commits', { message: input.title, tree: newTree.sha, parents: [input.baseCommit] });
    await this.call('POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: commit.sha });
    const pr = await this.call<{ number: number; html_url: string }>('POST', '/pulls', { title: input.title, body: input.body, head: input.branch, base: 'main', draft: true });
    return { number: pr.number, url: pr.html_url };
  }
}
