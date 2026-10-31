import type { Config } from '../config.js';
import type { TokenEntry } from './auth.js';

export function tokenEntries(cfg: Pick<Config, 'API_SERVICE_TOKEN' | 'OPERATOR_TOKEN' | 'TENANT_ID'>): TokenEntry[] {
  if (cfg.API_SERVICE_TOKEN === cfg.OPERATOR_TOKEN) throw new Error('Service and operator tokens must differ');
  return [
    {
      token: cfg.API_SERVICE_TOKEN, role: 'service',
      // The tenant is determined server-side; clients cannot choose it.
      principal: { name: 'owner-via-mcp', tenantId: cfg.TENANT_ID, permissions: ['billing:read', 'billing:write', 'features:write', 'notifications'] },
    },
    { token: cfg.OPERATOR_TOKEN, role: 'operator', principal: { name: 'operator', tenantId: cfg.TENANT_ID, permissions: [] } },
  ];
}
