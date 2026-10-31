import { loadConfig } from '../config.js';
import { MySqlStore } from '../store/mysql.js';
import { seed } from './seed-data.js';

// Explicit step only; never run automatically and never resets existing data.
const cfg = loadConfig();
const store = await MySqlStore.connect(cfg.DATABASE_URL);
const res = await store.transaction(cfg.TENANT_ID, (tx) => seed(tx));
console.log(res.skipped ? 'tenant already has data; seed skipped' : 'seed applied');
await store.close();
