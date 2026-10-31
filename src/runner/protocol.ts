import { z } from 'zod';

export const RunRequest = z.strictObject({
  jobId: z.string().uuid(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  task: z.string().min(10).max(50_000),
});
export type RunRequest = z.infer<typeof RunRequest>;

const Check = z.object({ name: z.string(), ok: z.boolean(), exitCode: z.number().nullable(), outputTail: z.string() });
export type Check = z.infer<typeof Check>;

export const RunResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    before: z.array(Check),
    after: z.array(Check),
    files: z.array(z.object({ path: z.string(), content: z.string().nullable(), existedBefore: z.boolean() })),
    agentLogTail: z.string(),
  }),
  z.object({ status: z.literal('needs_human'), reason: z.string(), before: z.array(Check).optional(), after: z.array(Check).optional() }),
]);
export type RunResult = z.infer<typeof RunResult>;

export interface RunnerPort { run(req: RunRequest): Promise<RunResult> }

export const RunStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({ state: z.literal('done'), result: RunResult }),
]);

/**
 * Starts a run and polls for its result. Runs take far longer than HTTP header timeouts,
 * so the runner answers immediately and the worker polls; restarts re-attach by job id.
 */
export class RunnerClient implements RunnerPort {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private pollMs = 10_000,
    private deadlineMs = 75 * 60_000,
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`runner ${method} ${path}: ${res.status}`);
    return res.json();
  }

  async run(req: RunRequest): Promise<RunResult> {
    await this.call('POST', '/v1/runs', req);
    const deadline = Date.now() + this.deadlineMs;
    while (Date.now() < deadline) {
      const status = RunStatus.parse(await this.call('GET', `/v1/runs/${req.jobId}`));
      if (status.state === 'done') return status.result;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new Error('runner deadline exceeded');
  }
}
