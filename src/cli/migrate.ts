import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { MySqlStore } from '../store/mysql.js';

const cfg = loadConfig();
const store = await MySqlStore.connect(cfg.DATABASE_URL);
const dir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../migrations', import.meta.url));
const applied = await store.migrate(dir);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
await store.close();
