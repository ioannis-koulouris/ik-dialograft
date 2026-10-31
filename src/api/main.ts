import { loadConfig } from '../config.js';
import { ArtifactStore } from '../services/artifacts.js';
import { TestMailer } from '../services/testmail.js';
import { MySqlStore } from '../store/mysql.js';
import { buildApi } from './server.js';
import { tokenEntries } from './tokens.js';

const cfg = loadConfig();
if (cfg.MCP_CLIENT_TOKEN === cfg.API_SERVICE_TOKEN) throw new Error('MCP client token and API service token must differ');
const store = await MySqlStore.connect(cfg.DATABASE_URL);
const app = buildApi({ deps: { store, artifacts: new ArtifactStore(cfg.ARTIFACT_DIR), today: cfg.DEMO_TODAY, mailer: new TestMailer(cfg.SMTP_HOST, cfg.SMTP_PORT) }, tokens: tokenEntries(cfg), logger: true });
await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void app.close().then(() => store.close()));
