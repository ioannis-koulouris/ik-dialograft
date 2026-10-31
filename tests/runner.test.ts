import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runJob, type RunnerConfig } from '../src/runner/controller.js';
import type { ExecResult } from '../src/runner/exec.js';
import { checkChange, checkChanges } from '../src/runner/policy.js';
import { diff, fingerprint } from '../src/runner/workspace.js';
import { TestMailer } from '../src/services/testmail.js';

const f = (path: string, extra: Partial<Parameters<typeof checkChange>[0]> = {}) => ({ path, kind: 'file' as const, existedBefore: false, deleted: false, ...extra });

describe('runner policy', () => {
  it('allows new/changed TypeScript under src and new tests', () => {
    expect(checkChanges([f('src/services/reminders.ts'), f('src/tools/registry.ts', { existedBefore: true }), f('tests/reminders.test.ts'), f('contracts/openapi.json', { existedBefore: true })])).toEqual([]);
  });
  it('blocks protected areas, dependencies, infra, existing tests, deletions, symlinks', () => {
    for (const c of [
      f('package.json', { existedBefore: true }), f('package-lock.json'), f('src/api/auth.ts', { existedBefore: true }), f('src/config.ts'),
      f('src/runner/controller.ts'), f('src/worker/handlers.ts'), f('k8s/api.yaml'), f('.github/workflows/ci.yml'), f('migrations/002.sql'),
      f('tests/billing.test.ts', { existedBefore: true }), f('src/services/billing.ts', { deleted: true }), f('src/x.ts', { kind: 'symlink' }),
      f('../outside.ts'), f('scripts/x.sh'), f('contracts/other.json'), f('contracts/openapi.json', { deleted: true, existedBefore: true }),
    ]) expect(checkChange(c), c.path).toBeDefined();
    expect(checkChanges([])).toEqual(['no changes produced']);
  });
});

describe('workspace diff', () => {
  it('detects added, modified, deleted files and symlinks without following them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dg-ws-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'a');
    await writeFile(join(root, 'src/b.ts'), 'b');
    const before = await fingerprint(root);
    await writeFile(join(root, 'src/a.ts'), 'a2');
    await writeFile(join(root, 'src/c.ts'), 'c');
    await symlink('/etc/passwd', join(root, 'src/evil.ts'));
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'src/b.ts'));
    const changes = diff(before, await fingerprint(root));
    expect(changes.map((c) => [c.path, c.kind, c.deleted])).toEqual([
      ['src/a.ts', 'file', false], ['src/b.ts', 'file', true], ['src/c.ts', 'file', false], ['src/evil.ts', 'symlink', false],
    ]);
    expect(checkChanges(changes)).toEqual([expect.stringContaining("deleting"), expect.stringContaining("regular files")]);
  });
});

describe('runner controller', () => {
  it('runs checks before and after in containers and returns changed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dg-run-'));
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
      calls.push([cmd, ...args]);
      if (cmd === 'sh') { // archive step: materialize a tiny repo
        const work = args[args.length - 1]!;
        await mkdir(join(work, 'src'), { recursive: true });
        await writeFile(join(work, 'package-lock.json'), '{}');
        await writeFile(join(work, 'src/a.ts'), 'a');
      }
      if (cmd === 'docker' && args.at(-1) === 'agent') {
        const work = args[args.indexOf('-v') + 1]!.split(':')[0]!;
        await writeFile(join(work, 'src/reminders.ts'), 'export {}');
      }
      return { exitCode: 0, output: '', timedOut: false };
    };
    const cfg: RunnerConfig = { token: 't'.repeat(32), workRoot: root, repoUrl: 'https://example.invalid/repo.git', image: 'img', ollamaUrlForContainer: 'http://h:11434', model: 'm', agentTimeoutMs: 1000, checkTimeoutMs: 1000, exec };
    const res = await runJob(cfg, { jobId: '00000000-0000-4000-8000-000000000001', commit: 'a'.repeat(40), task: 'implement the thing' });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.files).toEqual([{ path: 'src/reminders.ts', content: 'export {}', existedBefore: false }]);
    const dockerRuns = calls.filter((c) => c[0] === 'docker');
    expect(dockerRuns).toHaveLength(8);
    for (const r of dockerRuns) {
      expect(r).toContain('--cap-drop');
      expect(r.join(' ')).not.toContain('docker.sock');
    }
    expect(dockerRuns.filter((r) => r.includes('check') || r.includes('generate')).every((r) => r[r.indexOf('--network') + 1] === 'none')).toBe(true);
  });
});

describe('test mailer', () => {
  it('refuses real recipients', () => {
    expect(() => TestMailer.assertTestRecipient('a@example.com')).toThrow();
    expect(() => TestMailer.assertTestRecipient('a@kunde.invalid')).not.toThrow();
  });
});

describe('runner HTTP protocol', () => {
  it('answers immediately, re-attaches by job id and delivers the result by polling', async () => {
    const { buildRunnerServer } = await import('../src/runner/controller.js');
    const { RunnerClient } = await import('../src/runner/protocol.js');
    const root = await mkdtemp(join(tmpdir(), 'dg-proto-'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd === 'git') await gate; // hold the run so the client must poll
      if (cmd === 'sh') await writeFile(join(args[args.length - 1]!, 'package-lock.json'), '{}');
      return { exitCode: 0, output: '', timedOut: false };
    };
    const token = 't'.repeat(32);
    const server = buildRunnerServer({ token, workRoot: root, repoUrl: 'x', image: 'img', ollamaUrlForContainer: 'h', model: 'm', agentTimeoutMs: 1000, checkTimeoutMs: 1000, exec });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new RunnerClient(url, token, fetch, 20, 5000);
    const req = { jobId: '00000000-0000-4000-8000-000000000002', commit: 'a'.repeat(40), task: 'implement the thing' };
    const pending = client.run(req);
    await new Promise((r) => setTimeout(r, 60));
    const busy = await fetch(`${url}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...req, jobId: '00000000-0000-4000-8000-000000000003' }) });
    expect(busy.status).toBe(409);
    const again = await fetch(`${url}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(req) });
    expect(again.status).toBe(202);
    release();
    const result = await pending;
    expect(result.status).toBe('needs_human'); // agent produced no changes in this fake
    server.close();
  });
});
