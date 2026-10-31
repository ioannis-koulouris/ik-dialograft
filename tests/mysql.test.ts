import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seed } from '../src/cli/seed-data.js';
import { MySqlStore } from '../src/store/mysql.js';

const url = process.env.DIALOGRAFT_TEST_DATABASE_URL;

// Runs in CI against a MySQL service; explicitly skipped locally without a database.
describe.skipIf(!url)('MySqlStore (integration)', () => {
  it('migrates, seeds, rolls back and serializes', async () => {
    const store = await MySqlStore.connect(url!);
    await store.migrate(fileURLToPath(new URL('../migrations', import.meta.url)));
    const tenant = `t-${Date.now()}`;
    await store.transaction(tenant, (tx) => seed(tx));
    expect(await store.transaction(tenant, (tx) => tx.list('invoice'))).toHaveLength(8);
    await expect(store.transaction(tenant, async (tx) => {
      await tx.put('customer', { id: 'tmp', name: 'rollback' });
      await tx.notify('x', 'y');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await store.transaction(tenant, (tx) => tx.get('customer', 'tmp'))).toBeUndefined();
    const seqs = await Promise.all(Array.from({ length: 5 }, () => store.transaction(tenant, (tx) => tx.nextSeq('R'))));
    expect(new Set(seqs).size).toBe(5);
    await store.transaction(tenant, (tx) => tx.enqueueJob('feature.assess', { a: 1 }));
    const job = await store.claimJob('w1', ['feature.assess']);
    expect(job?.status).toBe('running');
    await store.finishJob(job!.id, 'paused', 'why');
    expect((await store.requeueJob(job!.id))?.status).toBe('queued');
    await store.close();
  });
});
