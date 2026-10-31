import { randomUUID } from 'node:crypto';
import type { Job, JobStatus, Kind, Notification, Store, Tx } from './store.js';

interface TenantState {
  docs: Map<string, unknown>;
  seq: Map<string, number>;
  notifications: Notification[];
  audit: unknown[];
  receipts: Map<string, unknown>;
}

/** Test-only store. The application entry points never fall back to it. */
export class MemoryStore implements Store {
  private tenants = new Map<string, TenantState>();
  private locks = new Map<string, Promise<unknown>>();
  private jobs = new Map<string, Job>();
  private cursor = 0;

  private state(tenantId: string): TenantState {
    let s = this.tenants.get(tenantId);
    if (!s) {
      s = { docs: new Map(), seq: new Map(), notifications: [], audit: [], receipts: new Map() };
      this.tenants.set(tenantId, s);
    }
    return s;
  }

  async transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(tenantId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.runTx(tenantId, fn));
    this.locks.set(tenantId, run);
    return run;
  }

  private async runTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const live = this.state(tenantId);
    const s: TenantState = structuredClone(live);
    const newJobs: Job[] = [];
    const cursorBefore = this.cursor;
    const tx: Tx = {
      tenantId,
      get: async <D>(kind: Kind, id: string) => structuredClone(s.docs.get(`${kind}:${id}`)) as D | undefined,
      list: async <D>(kind: Kind) =>
        [...s.docs.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, v]) => structuredClone(v) as D),
      put: async (kind, doc) => void s.docs.set(`${kind}:${doc.id}`, structuredClone(doc)),
      nextSeq: async (name) => {
        const v = (s.seq.get(name) ?? 0) + 1;
        s.seq.set(name, v);
        return v;
      },
      enqueueJob: async (type, payload) => {
        const id = randomUUID();
        newJobs.push({ id, tenantId, type, payload, status: 'queued', attempts: 0 });
        return id;
      },
      notify: async (type, message, data = {}) =>
        void s.notifications.push({ cursor: ++this.cursor, type, message, data, createdAt: new Date().toISOString(), acknowledged: false }),
      listNotifications: async (after, limit, includeAck) =>
        s.notifications.filter((n) => n.cursor > after && (includeAck || !n.acknowledged)).slice(0, limit),
      ackNotifications: async (cursors) => {
        let n = 0;
        for (const x of s.notifications) if (cursors.includes(x.cursor) && !x.acknowledged) { x.acknowledged = true; n++; }
        return n;
      },
      audit: async (actor, action, detail) => void s.audit.push({ actor, action, detail }),
      getReceipt: async (key) => structuredClone(s.receipts.get(key)),
      putReceipt: async (key, result) => void s.receipts.set(key, structuredClone(result)),
    };
    try {
      const result = await fn(tx);
      this.tenants.set(tenantId, s);
      for (const j of newJobs) this.jobs.set(j.id, j);
      return result;
    } catch (err) {
      this.cursor = Math.max(this.cursor, cursorBefore);
      throw err;
    }
  }

  async claimJob(_workerId: string, types: string[]) {
    for (const j of this.jobs.values()) {
      if (j.status === 'queued' && types.includes(j.type)) {
        j.status = 'running';
        j.attempts++;
        return structuredClone(j);
      }
    }
    return undefined;
  }

  async finishJob(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, error?: string) {
    const j = this.jobs.get(id);
    if (j) { j.status = status; j.lastError = error; }
  }

  async requeueJob(id: string) {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'paused' && j.status !== 'failed')) return undefined;
    j.status = 'queued';
    return structuredClone(j);
  }

  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j && structuredClone(j);
  }

  /** Test helper. */
  allJobs(): Job[] {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }

  async close() {}
}
