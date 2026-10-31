import { mkdir, writeFile } from 'node:fs/promises';
import { buildOpenApi } from '../src/api/openapi.js';
import { mcpToolCatalog } from '../src/mcp/server.js';

// Writes the generated contracts so changes show up in review. CI fails if they are stale.
await mkdir('contracts', { recursive: true });
await writeFile('contracts/openapi.json', `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
await writeFile('contracts/mcp-tools.json', `${JSON.stringify(mcpToolCatalog(), null, 2)}\n`);
console.log('contracts written');
