/**
 * Explicit store contract. Business aggregates are stored as indexed JSON documents;
 * jobs, notifications, audit entries and idempotency receipts live next to them so that
 * every business change and its side records commit atomically.
 */
import type { Kind } from '../domain/kinds.js';

export type { Kind };

export interface Notification {
  cursor: number;
  type: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
  acknowledged: boolean;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'paused' | 'failed';
export interface Job {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  lastError?: string;
}

export interface Tx {
  readonly tenantId: string;
  get<T>(kind: Kind, id: string): Promise<T | undefined>;
  list<T>(kind: Kind): Promise<T[]>;
  put<T extends { id: string }>(kind: Kind, doc: T): Promise<void>;
  nextSeq(name: string): Promise<number>;
  enqueueJob(type: string, payload: Record<string, unknown>): Promise<string>;
  notify(type: string, message: string, data?: Record<string, unknown>): Promise<void>;
  listNotifications(afterCursor: number, limit: number, includeAcknowledged: boolean): Promise<Notification[]>;
  ackNotifications(cursors: number[]): Promise<number>;
  audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void>;
  getReceipt(key: string): Promise<unknown | undefined>;
  putReceipt(key: string, result: unknown): Promise<void>;
}

export interface Store {
  /** Runs fn in a transaction serialized per tenant. Rolls back on throw. */
  transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  claimJob(workerId: string, types: string[]): Promise<Job | undefined>;
  finishJob(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, error?: string): Promise<void>;
  requeueJob(id: string): Promise<Job | undefined>;
  getJob(id: string): Promise<Job | undefined>;
  close(): Promise<void>;
}
