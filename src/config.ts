import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().default(8080),
  MCP_PORT: z.coerce.number().int().default(8081),
  API_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  MCP_CLIENT_TOKEN: z.string().min(24),
  API_SERVICE_TOKEN: z.string().min(24),
  OPERATOR_TOKEN: z.string().min(24),
  RUNNER_TOKEN: z.string().min(24).optional(),
  RUNNER_URL: z.string().url().optional(),
  ARTIFACT_DIR: z.string().default('./data/artifacts'),
  TENANT_ID: z.string().default('demo-tenant'),
  DEMO_TODAY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-10-30'),
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3-coder:30b'),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().default('ioannis-koulouris/dialograft'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  DEV_RATE_EUR_PER_HOUR: z.coerce.number().positive().default(100),
  DEV_RISK_SURCHARGE_PCT: z.coerce.number().min(0).max(100).default(20),
});
export type Config = z.infer<typeof Env>;

/** Loads configuration; fails loudly instead of silently falling back. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
