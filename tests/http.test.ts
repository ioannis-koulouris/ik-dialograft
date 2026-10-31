import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api/server.js';
import { tokenEntries } from '../src/api/tokens.js';
import { buildMcpHttp } from '../src/mcp/server.js';
import { setup } from './helpers.js';

const T = { API_SERVICE_TOKEN: 's'.repeat(32), OPERATOR_TOKEN: 'o'.repeat(32), TENANT_ID: 'demo-tenant' };
const CLIENT = 'c'.repeat(32);

let apiUrl = '';
let mcpUrl = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const { deps } = await setup();
  const api = buildApi({ deps, tokens: tokenEntries(T) });
  await api.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const mcp = buildMcpHttp({ apiBaseUrl: apiUrl, apiToken: T.API_SERVICE_TOKEN, clientToken: CLIENT });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  close = async () => { await api.close(); await new Promise((r) => mcp.close(r)); };
});
afterAll(() => close());

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe('API', () => {
  it('rejects missing/wrong tokens with 401 and wrong roles with 403', async () => {
    expect((await post('/v1/tools/list_open_items', {})).status).toBe(401);
    expect((await post('/v1/tools/list_open_items', {}, CLIENT)).status).toBe(401);
    expect((await post('/v1/tools/list_open_items', {}, T.OPERATOR_TOKEN)).status).toBe(403);
    expect((await post('/v1/operator/feature-requests/x/requeue', { stage: 'assess', reason: 'geklärt mit Kunde' }, T.API_SERVICE_TOKEN)).status).toBe(403);
    expect((await post('/v1/tools/list_open_items', {}, T.API_SERVICE_TOKEN)).status).toBe(200);
  });

  it('serves an OpenAPI document generated from the tool schemas', async () => {
    const res = await fetch(`${apiUrl}/openapi.json`, { headers: { authorization: `Bearer ${T.API_SERVICE_TOKEN}` } });
    const doc = await res.json();
    expect(doc.paths['/v1/tools/record_payment'].post.requestBody.content['application/json'].schema.required).toContain('confirm');
  });

  it('downloads exports only with authorization', async () => {
    const r = await (await post('/v1/tools/export_open_items_xlsx', {}, T.API_SERVICE_TOKEN)).json();
    expect((await fetch(`${apiUrl}${r.result.downloadPath}`)).status).toBe(401);
    const ok = await fetch(`${apiUrl}${r.result.downloadPath}`, { headers: { authorization: `Bearer ${T.API_SERVICE_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(r.result.sizeBytes);
    expect(ok.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('only accepts the approved commit as deployed', async () => {
    const res = await post('/v1/operator/feature-requests/FR-9999/deployed', { commit: 'a'.repeat(40) }, T.OPERATOR_TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('rejects the API token and missing tokens', async () => {
    for (const token of [undefined, T.API_SERVICE_TOKEN]) {
      const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}' });
      expect(res.status).toBe(401);
    }
  });

  it('lists tools and calls the real API', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${CLIENT}` } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('list_open_items');
    expect(tools.find((t) => t.name === 'accept_dev_offer')!.inputSchema.required).toContain('confirm');
    const res = await client.callTool({ name: 'list_open_items', arguments: { minDaysOverdue: 14 } });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.result.count).toBe(4);
    const bad = await client.callTool({ name: 'list_open_items', arguments: { tenantId: 'x' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
