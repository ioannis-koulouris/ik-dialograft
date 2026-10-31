import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { GitHubClient } from '../adapters/github.js';
import { OllamaAssessor } from '../adapters/ollama.js';
import { loadConfig } from '../config.js';
import { RunnerClient } from '../runner/protocol.js';
import { MySqlStore } from '../store/mysql.js';
import { runOnce, type WorkerDeps } from './handlers.js';

const cfg = loadConfig();
if (!cfg.GITHUB_TOKEN || !cfg.RUNNER_URL || !cfg.RUNNER_TOKEN) throw new Error('worker requires GITHUB_TOKEN, RUNNER_URL and RUNNER_TOKEN');
const store = await MySqlStore.connect(cfg.DATABASE_URL);
const deps: WorkerDeps = {
  store,
  github: new GitHubClient(cfg.GITHUB_REPO, cfg.GITHUB_TOKEN),
  assessor: new OllamaAssessor(cfg.OLLAMA_URL, cfg.OLLAMA_MODEL),
  runner: new RunnerClient(cfg.RUNNER_URL, cfg.RUNNER_TOKEN),
  pricing: { ratePerHourCents: Math.round(cfg.DEV_RATE_EUR_PER_HOUR * 100), riskSurchargePct: cfg.DEV_RISK_SURCHARGE_PCT },
  today: cfg.DEMO_TODAY,
};
const id = `${hostname()}-${process.pid}`;
let stop = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop = true; });
console.log(`worker ${id} started`);
while (!stop) {
  if (!(await runOnce(deps, id))) await sleep(2000);
}
await store.close();
