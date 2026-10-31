import { spawn } from 'node:child_process';

export interface ExecResult { exitCode: number | null; output: string; timedOut: boolean }

/** Runs a process without a shell, with a hard timeout and bounded output capture. */
export function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; maxOutput?: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const max = opts.maxOutput ?? 200_000;
    let output = '';
    let timedOut = false;
    const append = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-max); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, output: String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }); });
  });
}
