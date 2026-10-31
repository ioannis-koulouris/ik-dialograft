import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import type { Job, JobStatus, Kind, Notification, Store, Tx } from './store.js';

const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

export class MySqlStore implements Store {
  private constructor(private pool: Pool) {}

  static async connect(url: string): Promise<MySqlStore> {
    const pool = mysql.createPool({ uri: url, connectionLimit: 10, multipleStatements: true, timezone: 'Z' });
    await pool.query('SELECT 1');
    return new MySqlStore(pool);
  }

  async migrate(dir: string): Promise<string[]> {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(191) PRIMARY KEY, applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))');
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name as string));
    const applied: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await this.pool.query(await readFile(join(dir, file), 'utf8'));
      await this.pool.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      applied.push(file);
    }
    return applied;
  }

  async transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runTx(tenantId, fn);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw err;
      }
    }
  }

  private async runTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Tenant row is created in autocommit so concurrent first transactions only contend on the row lock.
    await this.pool.query('INSERT IGNORE INTO tenants (id) VALUES (?)', [tenantId]);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // Serializes all transactions of one tenant (small demo data set, see PRD §10).
      await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
      const result = await fn(this.tx(conn, tenantId));
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  private tx(conn: PoolConnection, tenantId: string): Tx {
    return {
      tenantId,
      get: async <D>(kind: Kind, id: string) => {
        const [rows] = await conn.query<RowDataPacket[]>('SELECT doc FROM aggregates WHERE tenant_id=? AND kind=? AND id=?', [tenantId, kind, id]);
        return rows[0] ? (parse(rows[0].doc) as D) : undefined;
      },
      list: async <D>(kind: Kind) => {
        const [rows] = await conn.query<RowDataPacket[]>('SELECT doc FROM aggregates WHERE tenant_id=? AND kind=? ORDER BY id', [tenantId, kind]);
        return rows.map((r) => parse(r.doc) as D);
      },
      put: async (kind, doc) => {
        await conn.query('INSERT INTO aggregates (tenant_id, kind, id, doc) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE doc=VALUES(doc)', [tenantId, kind, doc.id, JSON.stringify(doc)]);
      },
      nextSeq: async (name) => {
        await conn.query('INSERT INTO sequences (tenant_id, name, value) VALUES (?,?,1) ON DUPLICATE KEY UPDATE value=LAST_INSERT_ID(value+1)', [tenantId, name]);
        const [rows] = await conn.query<RowDataPacket[]>('SELECT value FROM sequences WHERE tenant_id=? AND name=?', [tenantId, name]);
        return Number(rows[0]!.value);
      },
      enqueueJob: async (type, payload) => {
        const id = randomUUID();
        await conn.query('INSERT INTO jobs (id, tenant_id, type, payload) VALUES (?,?,?,?)', [id, tenantId, type, JSON.stringify(payload)]);
        return id;
      },
      notify: async (type, message, data = {}) => {
        await conn.query('INSERT INTO notifications (tenant_id, type, message, data) VALUES (?,?,?,?)', [tenantId, type, message, JSON.stringify(data)]);
      },
      listNotifications: async (after, limit, includeAck) => {
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT * FROM notifications WHERE tenant_id=? AND cursor_id>? ${includeAck ? '' : 'AND acknowledged_at IS NULL'} ORDER BY cursor_id LIMIT ?`,
          [tenantId, after, limit],
        );
        return rows.map((r): Notification => ({
          cursor: Number(r.cursor_id), type: r.type, message: r.message, data: parse(r.data),
          createdAt: new Date(r.created_at).toISOString(), acknowledged: r.acknowledged_at !== null,
        }));
      },
      ackNotifications: async (cursors) => {
        if (cursors.length === 0) return 0;
        const [res] = await conn.query<ResultSetHeader>('UPDATE notifications SET acknowledged_at=CURRENT_TIMESTAMP(3) WHERE tenant_id=? AND acknowledged_at IS NULL AND cursor_id IN (?)', [tenantId, cursors]);
        return res.affectedRows;
      },
      audit: async (actor, action, detail) => {
        await conn.query('INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES (?,?,?,?)', [tenantId, actor, action, JSON.stringify(detail)]);
      },
      getReceipt: async (key) => {
        const [rows] = await conn.query<RowDataPacket[]>('SELECT result FROM receipts WHERE tenant_id=? AND idem_key=?', [tenantId, key]);
        return rows[0] ? parse(rows[0].result) : undefined;
      },
      putReceipt: async (key, result) => {
        await conn.query('INSERT INTO receipts (tenant_id, idem_key, result) VALUES (?,?,?)', [tenantId, key, JSON.stringify(result)]);
      },
    };
  }

  private toJob(r: RowDataPacket): Job {
    return { id: r.id, tenantId: r.tenant_id, type: r.type, payload: parse(r.payload), status: r.status, attempts: r.attempts, lastError: r.last_error ?? undefined };
  }

  async claimJob(workerId: string, types: string[]): Promise<Job | undefined> {
    if (types.length === 0) return undefined;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT * FROM jobs WHERE status='queued' AND type IN (?) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED", [types]);
      const row = rows[0];
      if (!row) { await conn.commit(); return undefined; }
      await conn.query("UPDATE jobs SET status='running', attempts=attempts+1, locked_by=?, locked_at=CURRENT_TIMESTAMP(3) WHERE id=?", [workerId, row.id]);
      await conn.commit();
      return { ...this.toJob(row), status: 'running', attempts: row.attempts + 1 };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async finishJob(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, error?: string) {
    await this.pool.query('UPDATE jobs SET status=?, last_error=?, locked_by=NULL WHERE id=?', [status, error ?? null, id]);
  }

  async requeueJob(id: string) {
    const [res] = await this.pool.query<ResultSetHeader>("UPDATE jobs SET status='queued', last_error=NULL WHERE id=? AND status IN ('paused','failed')", [id]);
    return res.affectedRows ? this.getJob(id) : undefined;
  }

  async getJob(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM jobs WHERE id=?', [id]);
    return rows[0] ? this.toJob(rows[0]) : undefined;
  }

  async close() {
    await this.pool.end();
  }
}
