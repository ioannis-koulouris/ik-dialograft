import { loadConfig } from '../config.js';
import type { ExportFile } from '../domain/types.js';
import { ArtifactStore } from '../services/artifacts.js';
import { MySqlStore } from '../store/mysql.js';

// Removes export files without metadata (left behind by failed transactions).
// Dry run by default; pass --delete to remove. Only files older than one hour are considered.
const cfg = loadConfig();
const dryRun = !process.argv.includes('--delete');
const store = await MySqlStore.connect(cfg.DATABASE_URL);
const artifacts = new ArtifactStore(cfg.ARTIFACT_DIR);
const referenced = await store.transaction(cfg.TENANT_ID, async (tx) => new Set((await tx.list<ExportFile>('export')).map((e) => e.relPath)));
const orphans = await artifacts.sweepOrphans(cfg.TENANT_ID, referenced, { minAgeMs: 60 * 60_000, dryRun });
console.log(`${orphans.length} orphaned export(s)${dryRun ? ' (dry run, use --delete)' : ' deleted'}`);
for (const o of orphans) console.log(`  ${o}`);
await store.close();
