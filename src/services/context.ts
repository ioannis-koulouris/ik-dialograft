import type { Tx } from '../store/store.js';

export interface Ctx {
  tx: Tx;
  /** Reference "today" (fixed for recordings, see PRD §3). */
  today: string;
  now: () => string;
  actor: string;
  newId: () => string;
}

export async function nextNumber(ctx: Ctx, prefix: string): Promise<string> {
  const n = await ctx.tx.nextSeq(prefix);
  return `${prefix}-${String(n).padStart(4, '0')}`;
}
