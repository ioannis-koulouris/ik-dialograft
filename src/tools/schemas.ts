import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const cents = z.number().int().nonnegative().max(1_000_000_000);
/** Demo recipients must use the reserved .invalid TLD so no real person is ever mailed. */
export const demoEmail = z.string().email().refine((e) => e.toLowerCase().endsWith('.invalid'), 'Nur .invalid-Adressen sind in der Demo erlaubt.');
const idempotencyKey = z.string().min(8).max(100).optional().describe('Optional key; repeating a call with the same key returns the first result.');
const confirm = z.literal(true).describe('Must be true and only set after the user explicitly confirmed this action.');
const ref = z.string().min(1).max(100);

const line = z.strictObject({
  description: z.string().min(1).max(200),
  quantity: z.number().positive().max(10_000),
  unitPriceCents: cents,
  taxRatePct: z.union([z.literal(0), z.literal(7), z.literal(19)]),
});

const decision = z.strictObject({
  topic: z.string().min(1).max(200),
  answer: z.string().max(500),
  status: z.enum(['confirmed', 'proposed', 'unknown']).describe('proposed = suggestion not yet confirmed by the user'),
});

export const scopePatch = z.strictObject({
  goal: z.string().max(1000).optional(),
  trigger: z.string().max(1000).optional(),
  affectedData: z.array(z.string().max(300)).max(30).optional(),
  behavior: z.array(z.string().max(500)).max(30).optional(),
  exceptions: z.array(z.string().max(500)).max(30).optional(),
  assumptions: z.array(z.string().max(500)).max(30).optional(),
  openQuestions: z.array(z.string().max(500)).max(30).optional(),
  acceptanceCriteria: z.array(z.string().max(500)).max(30).optional(),
  decisions: z.array(decision).max(30).optional(),
});

const openItemsFilter = { asOf: isoDate.optional(), minDaysOverdue: z.number().int().min(0).max(3650).optional() };

export const inputs = {
  list_capabilities: z.strictObject({}),
  create_customer: z.strictObject({ name: z.string().min(2).max(200), contactName: z.string().min(2).max(200), email: demoEmail, idempotencyKey }),
  search_customers: z.strictObject({ query: z.string().min(1).max(100) }),
  update_customer_contact: z.strictObject({ customer: ref, contactName: z.string().min(2).max(200).optional(), email: demoEmail.optional(), idempotencyKey }),
  create_quote: z.strictObject({ customer: ref, lines: z.array(line).min(1).max(50), idempotencyKey }),
  get_quote: z.strictObject({ quote: ref }),
  accept_quote: z.strictObject({ quote: ref, confirm, idempotencyKey }),
  create_invoice_from_quote: z.strictObject({ quote: ref, paymentTermDays: z.number().int().min(0).max(120).default(14), idempotencyKey }),
  get_invoice: z.strictObject({ invoice: ref }),
  record_payment: z.strictObject({ invoice: ref, amountCents: cents.positive(), date: isoDate.optional(), reference: z.string().min(1).max(100), confirm, idempotencyKey }),
  list_open_items: z.strictObject(openItemsFilter),
  report_receivables_by_customer: z.strictObject({ asOf: isoDate.optional() }),
  export_invoice_pdf: z.strictObject({ invoice: ref }),
  export_open_items_pdf: z.strictObject(openItemsFilter),
  export_open_items_xlsx: z.strictObject(openItemsFilter),
  export_open_items_csv: z.strictObject(openItemsFilter),
  list_feature_requests: z.strictObject({}),
  draft_feature_request: z.strictObject({ title: z.string().min(3).max(200), request: z.string().min(3).max(4000), scope: scopePatch.optional(), idempotencyKey }),
  get_feature_request: z.strictObject({ featureRequestId: ref }),
  update_feature_scope: z.strictObject({ featureRequestId: ref, scope: scopePatch, idempotencyKey }),
  confirm_feature_scope: z.strictObject({ featureRequestId: ref, scopeVersion: z.number().int().positive(), confirm, idempotencyKey }),
  accept_dev_offer: z.strictObject({ featureRequestId: ref, offerId: ref, offerVersion: z.number().int().positive(), confirm, idempotencyKey }),
  get_notifications: z.strictObject({ cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), includeAcknowledged: z.boolean().optional() }),
  acknowledge_notifications: z.strictObject({ cursors: z.array(z.number().int().positive()).min(1).max(100) }),
  configure_payment_reminders: z.strictObject({ asOf: isoDate.optional(), idempotencyKey }),
  configure_payment_reminders_2: z.strictObject({ asOf: isoDate.optional(), idempotencyKey }),
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof inputs;
