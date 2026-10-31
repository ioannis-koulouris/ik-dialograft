import { randomBytes } from 'node:crypto';

// Prints fresh local secrets in .env format. Never commit the output.
const t = () => randomBytes(32).toString('base64url');
for (const name of ['MCP_CLIENT_TOKEN', 'API_SERVICE_TOKEN', 'OPERATOR_TOKEN', 'RUNNER_TOKEN', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD']) console.log(`${name}=${t()}`);
