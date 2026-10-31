import type { Ctx } from './context.js';

export async function getNotifications(ctx: Ctx, input: { cursor?: number; limit?: number; includeAcknowledged?: boolean }) {
  const limit = input.limit ?? 20;
  const items = await ctx.tx.listNotifications(input.cursor ?? 0, limit, input.includeAcknowledged ?? false);
  const nextCursor = items.length ? items[items.length - 1]!.cursor : (input.cursor ?? 0);
  // Fetching does not mark as read; acknowledgement is explicit.
  return { items, nextCursor, hasMore: items.length === limit };
}

export async function acknowledgeNotifications(ctx: Ctx, input: { cursors: number[] }) {
  const acknowledged = await ctx.tx.ackNotifications(input.cursors);
  await ctx.tx.audit(ctx.actor, 'notifications.acknowledged', { cursors: input.cursors });
  return { acknowledged };
}
