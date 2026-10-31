import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { exec, type ExecResult } from './exec.js';
import { checkChanges } from './policy.js';
import { type Check, RunRequest, type RunResult } from './protocol.js';
import { diff, fingerprint } from './workspace.js';

export interface RunnerConfig {
  token: string;
  workRoot: string;
  /** Read-only clone URL of the controlled demo repository (credentials stay on the host). */
  repoUrl: string;
  image: string;
  ollamaUrlForContainer: string;
  model: string;
  agentTimeoutMs: number;
  checkTimeoutMs: number;
  exec?: typeof exec;
}

const CHECKS = ['typecheck', 'test', 'build'] as const;
const tail = (s: string) => s.slice(-4000);

/** Common container hardening. The container never gets the Docker socket, DB, GitHub, kube or home access. */
function dockerArgs(cfg: RunnerConfig, workDir: string, name: string, network: 'none' | 'bridge') {
  return [
    'run', '--rm', '--name', name, '--network', network,
    '--cpus', '6', '--memory', '12g', '--pids-limit', '1024',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
    '--read-only', '--tmpfs', '/tmp:rw,size=1g', '--tmpfs', '/home/agent:rw,size=512m',
    '-v', `${workDir}:/work:rw`, '-w', '/work',
  ];
}

export async function runJob(cfg: RunnerConfig, req: RunRequest): Promise<RunResult> {
  const run = cfg.exec ?? exec;
  const jobDir = join(cfg.workRoot, req.jobId);
  const gitDir = join(jobDir, 'repo.git');
  const workDir = join(jobDir, 'work');
  await rm(jobDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const git = (args: string[]) => run('git', args, { timeoutMs: 120_000 });
  const must = (r: ExecResult, what: string) => { if (r.exitCode !== 0) throw new Error(`${what} failed: ${tail(r.output)}`); };
  must(await git(['clone', '--bare', '--filter=blob:none', cfg.repoUrl, gitDir]), 'clone');
  // Export the pinned commit without .git so the agent cannot plant hooks or config the host would run.
  must(await run('sh', ['-c', 'git --git-dir="$0" archive "$1" | tar -x -C "$2"', gitDir, req.commit, workDir], { timeoutMs: 120_000 }), 'archive');

  const lock = (await readFile(join(workDir, 'package-lock.json'), 'utf8').catch(() => '')).length;
  if (!lock) return { status: 'needs_human', reason: 'package-lock.json missing' };

  const checks = async (label: string): Promise<Check[]> => {
    const results: Check[] = [];
    for (const name of CHECKS) {
      const r = await run('docker', [...dockerArgs(cfg, workDir, `dg-${label}-${name}-${req.jobId.slice(0, 8)}`, 'none'), cfg.image, 'check', name], { timeoutMs: cfg.checkTimeoutMs });
      results.push({ name: `${label}:${name}`, ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, outputTail: tail(r.output) });
    }
    return results;
  };

  const before = await checks('before');
  if (before.some((c) => !c.ok)) return { status: 'needs_human', reason: 'baseline checks fail before any change', before };

  const snapshot = await fingerprint(workDir);
  await writeFile(join(jobDir, 'TASK.md'), req.task);
  const agent = await run('docker', [
    ...dockerArgs(cfg, workDir, `dg-agent-${req.jobId.slice(0, 8)}`, 'bridge'),
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${join(jobDir, 'TASK.md')}:/task/TASK.md:ro`,
    '-e', `OPENAI_BASE_URL=${cfg.ollamaUrlForContainer}/v1`, '-e', 'OPENAI_API_KEY=ollama', '-e', `OPENAI_MODEL=${cfg.model}`,
    cfg.image, 'agent',
  ], { timeoutMs: cfg.agentTimeoutMs });
  if (agent.timedOut) return { status: 'needs_human', reason: 'coding agent timed out', before };
  if (agent.exitCode !== 0) return { status: 'needs_human', reason: `coding agent exited with ${agent.exitCode}`, before };

  // Regenerate contracts from the changed schemas so the PR matches CI; the agent cannot be trusted to.
  const gen = await run('docker', [...dockerArgs(cfg, workDir, `dg-gen-${req.jobId.slice(0, 8)}`, 'none'), cfg.image, 'generate', 'contracts'], { timeoutMs: cfg.checkTimeoutMs });
  if (gen.exitCode !== 0 || gen.timedOut) return { status: 'needs_human', reason: `contract generation failed: ${tail(gen.output)}`, before };

  const changes = diff(snapshot, await fingerprint(workDir));
  const violations = checkChanges(changes);
  if (violations.length) return { status: 'needs_human', reason: `policy: ${violations.join('; ')}`, before };

  const after = await checks('after');
  if (after.some((c) => !c.ok)) return { status: 'needs_human', reason: 'checks fail after change', before, after };

  const files = [];
  for (const c of changes) files.push({ path: c.path, existedBefore: c.existedBefore, content: c.deleted ? null : await readFile(join(workDir, c.path), 'utf8') });
  return { status: 'ok', before, after, files, agentLogTail: tail(agent.output) };
}

export function buildRunnerServer(cfg: RunnerConfig): Server {
  // One run at a time; results are kept in memory by job id until the controller restarts.
  const runs = new Map<string, RunResult | 'running'>();
  const busy = () => [...runs.values()].includes('running');
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const ok = m && Buffer.from(m[1]!).length === Buffer.from(cfg.token).length && timingSafeEqual(Buffer.from(m[1]!), Buffer.from(cfg.token));
    if (!ok) return send(401, { error: 'unauthorized' });

    const get = /^\/v1\/runs\/([0-9a-f-]{36})$/.exec(req.url ?? '');
    if (req.method === 'GET' && get) {
      const run = runs.get(get[1]!);
      if (!run) return send(404, { error: 'not_found' });
      return send(200, run === 'running' ? { state: 'running' } : { state: 'done', result: run });
    }
    if (req.method !== 'POST' || req.url !== '/v1/runs') return send(404, { error: 'not_found' });

    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 100_000) return send(413, { error: 'too_large' }); }
    let body: unknown;
    try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid_input' }); }
    const parsed = RunRequest.safeParse(body);
    if (!parsed.success) return send(400, { error: 'invalid_input' });
    const { jobId } = parsed.data;
    if (runs.has(jobId)) return send(202, { jobId }); // idempotent re-attach
    if (busy()) return send(409, { error: 'busy' });
    runs.set(jobId, 'running');
    void runJob(cfg, parsed.data)
      .catch((err): RunResult => ({ status: 'needs_human', reason: `runner error: ${(err as Error).message.slice(0, 500)}` }))
      .then((result) => runs.set(jobId, result));
    return send(202, { jobId });
  });
}
