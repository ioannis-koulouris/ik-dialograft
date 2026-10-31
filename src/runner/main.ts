import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildRunnerServer } from './controller.js';

// Native controller on the Mac. Binds to the loopback/OrbStack bridge only, never 0.0.0.0 by default.
const env = process.env;
if (!env.RUNNER_TOKEN || env.RUNNER_TOKEN.length < 24) throw new Error('RUNNER_TOKEN missing');
if (!env.RUNNER_REPO_URL) throw new Error('RUNNER_REPO_URL missing');
const server = buildRunnerServer({
  token: env.RUNNER_TOKEN,
  workRoot: env.RUNNER_WORK_DIR ?? join(homedir(), '.dialograft-runner'),
  repoUrl: env.RUNNER_REPO_URL,
  image: env.RUNNER_IMAGE ?? 'dialograft-coder:local',
  ollamaUrlForContainer: env.RUNNER_OLLAMA_URL ?? 'http://host.internal:11434',
  model: env.OLLAMA_MODEL ?? 'qwen3-coder:30b',
  agentTimeoutMs: Number(env.RUNNER_AGENT_TIMEOUT_MS ?? 45 * 60_000),
  checkTimeoutMs: Number(env.RUNNER_CHECK_TIMEOUT_MS ?? 10 * 60_000),
});
const host = env.RUNNER_HOST ?? '127.0.0.1';
const port = Number(env.RUNNER_PORT ?? 8090);
server.listen(port, host, () => console.log(`runner controller on ${host}:${port}`));
