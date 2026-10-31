import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/cli/seed-data.js';
import { ArtifactStore } from '../src/services/artifacts.js';
import { MemoryStore } from '../src/store/memory.js';
import { executeTool, type Deps, type Principal } from '../src/tools/registry.js';

export const TENANT = 'demo-tenant';
export const owner: Principal = { name: 'test-owner', tenantId: TENANT, permissions: ['billing:read', 'billing:write', 'features:write', 'notifications'] };

export async function setup() {
  const store = new MemoryStore();
  await store.transaction(TENANT, (tx) => seed(tx));
  const artifacts = new ArtifactStore(await mkdtemp(join(tmpdir(), 'dg-art-')));
  const deps: Deps = { store, artifacts, today: '2026-10-30' };
  const call = async <T = any>(name: string, input: unknown = {}, who: Principal = owner) =>
    (await executeTool(deps, who, name, input)) as { result: T; replayed: boolean; pendingNotifications: { cursor: number; type: string; message: string }[] };
  return { store, artifacts, deps, call };
}
