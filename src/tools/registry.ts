import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ArtifactStore } from '../services/artifacts.js';
import * as billing from '../services/billing.js';
import type { Ctx } from '../services/context.js';
import { AppError } from '../services/errors.js';
import * as exp from '../services/exports.js';
import * as features from '../services/features.js';
import * as notif from '../services/notifications.js';
import type { Store } from '../store/store.js';
import { inputs, type ToolName } from './schemas.js';

export type Permission = 'billing:read' | 'billing:write' | 'features:write' | 'notifications';

export interface Deps { store: Store; artifacts: ArtifactStore; today: string; mailer?: { send: (msg: { to: string; subject: string; text: string }) => Promise<unknown> } }

interface ToolDef<N extends ToolName> {
  description: string;
  permission: Permission;
  mutating: boolean;
  handler: (ctx: Ctx, input: z.infer<(typeof inputs)[N]>, deps: Deps) => Promise<unknown>;
}

type Registry = { [N in ToolName]: ToolDef<N> };

/** Known product gaps. A gap disappears once a tool implementing it is registered. */
export const KNOWN_GAPS = [
  {
    id: 'payment_reminders',
    title: 'Automatische Zahlungserinnerungen',
    message: 'Automatische Zahlungserinnerungen sind derzeit nicht verfügbar.',
    resolvedByTool: 'configure_payment_reminders',
  },
];

export const tools: Registry = {
  list_capabilities: {
    description: 'List the tools that currently exist and known product gaps. Use before telling the user a function is missing.',
    permission: 'billing:read', mutating: false,
    handler: async () => {
      const names = Object.keys(tools);
      return {
        tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, permission: t.permission })),
        knownGaps: KNOWN_GAPS.filter((g) => !names.includes(g.resolvedByTool)).map(({ resolvedByTool: _r, ...g }) => g),
        note: 'A missing permission or a technical error is not a product gap.',
      };
    },
  },
  create_customer: { description: 'Create a customer. Email must be a demo .invalid address.', permission: 'billing:write', mutating: true, handler: (c, i) => billing.createCustomer(c, i) },
  search_customers: { description: 'Search customers by name, contact, number or email.', permission: 'billing:read', mutating: false, handler: (c, i) => billing.searchCustomers(c, i.query) },
  update_customer_contact: { description: 'Change contact person and/or billing email of a customer. Ambiguous references return candidates.', permission: 'billing:write', mutating: true, handler: (c, i) => billing.updateCustomerContact(c, i) },
  create_quote: { description: 'Create a business quote with lines; net, tax and gross are computed in cents.', permission: 'billing:write', mutating: true, handler: (c, i) => billing.createQuote(c, i) },
  get_quote: { description: 'Get a business quote by id or number.', permission: 'billing:read', mutating: false, handler: (c, i) => billing.getQuote(c, i.quote) },
  accept_quote: { description: "Record the customer's confirmed acceptance of a business quote.", permission: 'billing:write', mutating: true, handler: (c, i) => billing.acceptQuote(c, i.quote) },
  create_invoice_from_quote: { description: 'Create a test invoice draft from an accepted quote.', permission: 'billing:write', mutating: true, handler: (c, i) => billing.createInvoiceFromQuote(c, i) },
  get_invoice: { description: 'Show an invoice with paid and open amounts.', permission: 'billing:read', mutating: false, handler: (c, i) => billing.getInvoice(c, i.invoice) },
  record_payment: { description: 'Record a confirmed (partial) payment. Overpayment is rejected.', permission: 'billing:write', mutating: true, handler: (c, i) => billing.recordPayment(c, i) },
  list_open_items: { description: 'List open invoices as of a reference date, optionally only those overdue by at least N days.', permission: 'billing:read', mutating: false, handler: (c, i) => billing.listOpenItems(c, i) },
  report_receivables_by_customer: { description: 'Summarize open and overdue amounts per customer.', permission: 'billing:read', mutating: false, handler: (c, i) => billing.receivablesByCustomer(c, i) },
  export_invoice_pdf: { description: 'Render an invoice draft as PDF.', permission: 'billing:read', mutating: true, handler: (c, i, d) => exp.exportInvoicePdf(c, d.artifacts, i.invoice) },
  export_open_items_pdf: { description: 'Render the open items report as PDF.', permission: 'billing:read', mutating: true, handler: (c, i, d) => exp.exportOpenItemsPdf(c, d.artifacts, i) },
  export_open_items_xlsx: { description: 'Export the open items report as a real .xlsx with numeric amounts and sums.', permission: 'billing:read', mutating: true, handler: (c, i, d) => exp.exportOpenItemsXlsx(c, d.artifacts, i) },
  export_open_items_csv: { description: 'Export the open items report as CSV (Deutsch, semicolon-separated, UTF-8 with BOM for Excel).', permission: 'billing:read', mutating: true, handler: (c, i, d) => exp.exportOpenItemsCsv(c, d.artifacts, i) },
  configure_payment_reminders: { description: 'Run a payment reminder check. Sends one reminder email per invoice that is at least 14 days overdue and not yet fully paid, but only if no reminder was sent before. Uses the optional asOf reference date (default: today).', permission: 'billing:write', mutating: true, handler: (c, i, d) => billing.runPaymentReminders(c, i, depsWithMailer(d)) },
  configure_payment_reminders_2: { description: 'Run a second payment reminder check (Mahnstufe 2). Sends one reminder email per invoice that is at least 30 days overdue and not yet fully paid, but only if a first reminder (Mahnstufe 1) was already sent. Uses the optional asOf reference date (default: today).', permission: 'billing:write', mutating: true, handler: (c, i, d) => billing.runPaymentReminders2(c, i, depsWithMailer(d)) },
  list_feature_requests: { description: 'List feature requests and their status.', permission: 'billing:read', mutating: false, handler: (c) => features.listFeatureRequests(c) },
  draft_feature_request: {
    description: 'Start a feature request after the user agreed to have a missing function checked. Put everything the user already said into scope so it is not asked again. Returns missing fields; ask about them one at a time.',
    permission: 'features:write', mutating: true, handler: (c, i) => features.draftFeatureRequest(c, i),
  },
  get_feature_request: { description: 'Get a feature request with scope, missing fields, assessment, offers and status.', permission: 'billing:read', mutating: false, handler: (c, i) => features.getFeatureRequest(c, i.featureRequestId) },
  update_feature_scope: {
    description: 'Update scope fields. Mark your suggestions as decisions with status "proposed" until the user confirms them. Changing an assessed scope invalidates open offers.',
    permission: 'features:write', mutating: true, handler: (c, i) => features.updateFeatureScope(c, i),
  },
  confirm_feature_scope: { description: 'Confirm the summarized scope version after the user explicitly agreed. Queues ticket creation and assessment.', permission: 'features:write', mutating: true, handler: (c, i) => features.confirmFeatureScope(c, i) },
  accept_dev_offer: { description: 'Accept the current non-binding development offer after explicit user consent. Creates a demo order and implementation job.', permission: 'features:write', mutating: true, handler: (c, i) => features.acceptDevOffer(c, i) },
  get_notifications: { description: 'Fetch notifications after a cursor. Fetching does not mark them as read.', permission: 'notifications', mutating: false, handler: (c, i) => notif.getNotifications(c, i) },
  acknowledge_notifications: { description: 'Explicitly acknowledge notifications by cursor. Acknowledging never approves anything.', permission: 'notifications', mutating: true, handler: (c, i) => notif.acknowledgeNotifications(c, i) },
};

export const toolNames = Object.keys(tools) as ToolName[];

export interface Principal { name: string; tenantId: string; permissions: Permission[] }

// Helper to assert that mailer is defined (safe because executeTool checks before calling this handler)
function depsWithMailer(d: Deps): { store: Store; artifacts: ArtifactStore; today: string; mailer: { send: (msg: { to: string; subject: string; text: string }) => Promise<unknown> } } {
  if (!d.mailer) throw new AppError(500, 'mailer_not_configured', 'Der Mailer ist nicht konfiguriert.');
  return d as never;
}

export function makeCtx(tx: Ctx['tx'], actor: string, today: string): Ctx {
  return { tx, actor, today, now: () => new Date().toISOString(), newId: randomUUID };
}

/** Validates, authorizes and executes one tool call inside a tenant transaction. */
export async function executeTool(deps: Deps, principal: Principal, name: string, raw: unknown) {
  if (!(name in tools)) throw new AppError(404, 'unknown_tool', `Unbekanntes Werkzeug ${name}.`);
  const tool = tools[name as ToolName] as ToolDef<ToolName>;
  const parsed = inputs[name as ToolName].safeParse(raw ?? {});
  if (!parsed.success) throw new AppError(400, 'invalid_input', 'Ungültige Eingabe.', parsed.error.issues);
  if (!principal.permissions.includes(tool.permission)) throw new AppError(403, 'forbidden', `Fehlende Berechtigung ${tool.permission}.`);
  const input = parsed.data as Record<string, unknown>;
  // Fail early if the tool requires a mailer but none is configured
  if (name === 'configure_payment_reminders' && (!deps.mailer || typeof deps.mailer.send !== 'function')) {
    throw new AppError(500, 'mailer_not_configured', 'Der Mailer ist nicht konfiguriert. Zahlungserinnerungen können nicht versendet werden.');
  }

  return deps.store.transaction(principal.tenantId, async (tx) => {
    const ctx = makeCtx(tx, principal.name, deps.today);
    const key = typeof input.idempotencyKey === 'string' ? `${name}:${input.idempotencyKey}` : undefined;
    let result = key ? await tx.getReceipt(key) : undefined;
    const replayed = result !== undefined;
    if (!replayed) {
      result = await tool.handler(ctx, input as never, deps);
      if (key) await tx.putReceipt(key, result);
    }
    const pending = name.endsWith('notifications') ? [] : await tx.listNotifications(0, 5, false);
    return { result, replayed, pendingNotifications: pending };
  });
}
