import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolInputJsonSchema } from '../api/openapi.js';
import { tools, toolNames } from '../tools/registry.js';

export interface McpOptions { apiBaseUrl: string; apiToken: string; clientToken: string; fetchImpl?: typeof fetch }

const INSTRUCTIONS = `Dialograft is a demo invoicing product. Rules:
- Before saying a function is missing, call list_capabilities. Permission errors (403) or technical errors are not product gaps.
- If a function is a known gap, say so and ask whether to have it checked and estimated. Only after "yes" call draft_feature_request.
- Ask for missing scope details one question per message; do not ask again for things the user already said. Your suggestions are "proposed" decisions until confirmed.
- confirm/accept tools need explicit user consent each time. Scope confirmation, offer acceptance and deployment are separate decisions.
- Show pendingNotifications from responses to the user. Acknowledge only when asked.`;

/** Catalogue generated from the same Zod schemas the API uses. */
export function mcpToolCatalog() {
  return toolNames.map((name) => ({ name, description: tools[name].description, inputSchema: toolInputJsonSchema(name) as { type: 'object' } }));
}

function createMcp(opts: McpOptions): Server {
  const server = new Server({ name: 'dialograft', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const doFetch = opts.fetchImpl ?? fetch;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolCatalog() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await doFetch(`${opts.apiBaseUrl}/v1/tools/${encodeURIComponent(req.params.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiToken}` },
      body: JSON.stringify(req.params.arguments ?? {}),
    });
    const text = await res.text();
    return { isError: !res.ok, content: [{ type: 'text', text: res.ok ? text : `HTTP ${res.status}: ${text}` }] };
  });
  return server;
}

function authorized(req: IncomingMessage, token: string) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export function buildMcpHttp(opts: McpOptions): HttpServer {
  if (opts.apiToken === opts.clientToken) throw new Error('MCP client token and API token must differ');
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    if (!authorized(req, opts.clientToken)) {
      return void res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end('{"error":"unauthorized"}');
    }
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    try {
      const body = await readJson(req);
      // Stateless: one server/transport per request; no session state to leak between clients.
      const server = createMcp(opts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => void transport.close().then(() => server.close()));
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad_request"}');
    }
  });
}
