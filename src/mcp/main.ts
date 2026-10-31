import { loadConfig } from '../config.js';
import { buildMcpHttp } from './server.js';

const cfg = loadConfig();
const server = buildMcpHttp({ apiBaseUrl: cfg.API_BASE_URL, apiToken: cfg.API_SERVICE_TOKEN, clientToken: cfg.MCP_CLIENT_TOKEN });
server.listen(cfg.MCP_PORT, '0.0.0.0', () => console.log(`dialograft MCP listening on :${cfg.MCP_PORT}/mcp`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close());
