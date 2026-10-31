import { addDays, daysBetween, formatEur, priceLine, totals, type LineInput } from '../domain/money.js';
import type { Customer, Invoice, Quote } from '../domain/types.js';
import { type Ctx, nextNumber } from './context.js';
import { AppError, conflict, invalid, notFound } from './errors.js';

const norm = (s: string) => s.toLocaleLowerCase('de').normalize('NFKD').replace(/[̀-ͯ]/g, '');

export async function createCustomer(ctx: Ctx, input: { name: string; contactName: string; email: string }): Promise<Customer> {
  const existing = (await ctx.tx.list<Customer>('customer')).find((c) => norm(c.name) === norm(input.name));
  if (existing) throw conflict('duplicate_customer', `Kunde „${existing.name}“ existiert bereits (${existing.number}).`, { customerId: existing.id });
  const c: Customer = { id: ctx.newId(), number: await nextNumber(ctx, 'K'), ...input, createdAt: ctx.now() };
  await ctx.tx.put('customer', c);
  await ctx.tx.audit(ctx.actor, 'customer.created', { id: c.id });
  return c;
}

export async function searchCustomers(ctx: Ctx, query: string): Promise<Customer[]> {
  const q = norm(query.trim());
  return (await ctx.tx.list<Customer>('customer')).filter(
    (c) => norm(c.name).includes(q) || norm(c.contactName).includes(q) || c.number.toLowerCase() === q || norm(c.email).includes(q),
  );
}

/** Resolves a customer reference; ambiguity is reported instead of guessed. */
export async function resolveCustomer(ctx: Ctx, ref: string): Promise<Customer> {
  const byId = await ctx.tx.get<Customer>('customer', ref);
  if (byId) return byId;
  const hits = await searchCustomers(ctx, ref);
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw notFound('Kunde', ref);
  throw new AppError(409, 'ambiguous_customer', `„${ref}“ passt auf mehrere Kunden. Bitte präzisieren.`, {
    candidates: hits.map((c) => ({ id: c.id, number: c.number, name: c.name })),
  });
}

export async function updateCustomerContact(ctx: Ctx, input: { customer: string; contactName?: string; email?: string }) {
  const c = await resolveCustomer(ctx, input.customer);
  if (input.contactName === undefined && input.email === undefined) throw invalid('Keine Änderung angegeben.');
  const updated: Customer = { ...c, contactName: input.contactName ?? c.contactName, email: input.email ?? c.email };
  await ctx.tx.put('customer', updated);
  await ctx.tx.audit(ctx.actor, 'customer.contact_updated', { id: c.id });
  return updated;
}

export async function createQuote(ctx: Ctx, input: { customer: string; lines: LineInput[] }): Promise<Quote> {
  const customer = await resolveCustomer(ctx, input.customer);
  const lines = input.lines.map(priceLine);
  const q: Quote = {
    id: ctx.newId(), number: await nextNumber(ctx, 'A'), customerId: customer.id, issueDate: ctx.today,
    lines, totals: totals(lines), status: 'open',
  };
  await ctx.tx.put('quote', q);
  await ctx.tx.audit(ctx.actor, 'quote.created', { id: q.id });
  return q;
}

async function findBy<T extends { id: string; number: string }>(ctx: Ctx, kind: 'quote' | 'invoice', ref: string, label: string): Promise<T> {
  const doc = (await ctx.tx.get<T>(kind, ref)) ?? (await ctx.tx.list<T>(kind)).find((d) => d.number.toLowerCase() === ref.toLowerCase());
  if (!doc) throw notFound(label, ref);
  return doc;
}
export const getQuote = (ctx: Ctx, ref: string) => findBy<Quote>(ctx, 'quote', ref, 'Angebot');
export const getInvoiceDoc = (ctx: Ctx, ref: string) => findBy<Invoice>(ctx, 'invoice', ref, 'Rechnung');

export async function acceptQuote(ctx: Ctx, ref: string): Promise<Quote> {
  const q = await getQuote(ctx, ref);
  if (q.status === 'accepted') return q;
  const accepted: Quote = { ...q, status: 'accepted', acceptedAt: ctx.now() };
  await ctx.tx.put('quote', accepted);
  await ctx.tx.audit(ctx.actor, 'quote.accepted', { id: q.id });
  return accepted;
}

export async function createInvoiceFromQuote(ctx: Ctx, input: { quote: string; paymentTermDays: number }): Promise<Invoice> {
  const q = await getQuote(ctx, input.quote);
  if (q.status !== 'accepted') throw conflict('quote_not_accepted', `Angebot ${q.number} ist noch nicht angenommen.`);
  const inv: Invoice = {
    id: ctx.newId(), number: await nextNumber(ctx, 'R'), customerId: q.customerId, quoteId: q.id,
    issueDate: ctx.today, dueDate: addDays(ctx.today, input.paymentTermDays), lines: q.lines, totals: q.totals,
    payments: [], testDraft: true,
  };
  await ctx.tx.put('invoice', inv);
  await ctx.tx.audit(ctx.actor, 'invoice.created', { id: inv.id });
  return inv;
}

export const paidCents = (inv: Invoice) => inv.payments.reduce((s, p) => s + p.amountCents, 0);
export const openCents = (inv: Invoice) => inv.totals.grossCents - paidCents(inv);

export function invoiceView(inv: Invoice, customer: Customer | undefined, asOf: string) {
  const open = openCents(inv);
  const daysOverdue = open > 0 ? Math.max(0, daysBetween(inv.dueDate, asOf)) : 0;
  return {
    ...inv, customerName: customer?.name ?? '?', paidCents: paidCents(inv), openCents: open,
    status: open === 0 ? 'paid' : paidCents(inv) > 0 ? 'partially_paid' : 'open',
    daysOverdue,
  };
}

export async function getInvoice(ctx: Ctx, ref: string) {
  const inv = await getInvoiceDoc(ctx, ref);
  return invoiceView(inv, await ctx.tx.get<Customer>('customer', inv.customerId), ctx.today);
}

export async function recordPayment(ctx: Ctx, input: { invoice: string; amountCents: number; date?: string; reference: string }) {
  const inv = await getInvoiceDoc(ctx, input.invoice);
  const open = openCents(inv);
  if (input.amountCents > open) {
    throw conflict('overpayment', `Zahlung übersteigt den offenen Betrag von ${open} Cent.`, { openCents: open });
  }
  const updated: Invoice = {
    ...inv, payments: [...inv.payments, { id: ctx.newId(), date: input.date ?? ctx.today, amountCents: input.amountCents, reference: input.reference }],
  };
  await ctx.tx.put('invoice', updated);
  await ctx.tx.audit(ctx.actor, 'invoice.payment_recorded', { id: inv.id, amountCents: input.amountCents });
  return invoiceView(updated, await ctx.tx.get<Customer>('customer', inv.customerId), ctx.today);
}

export async function listOpenItems(ctx: Ctx, input: { asOf?: string; minDaysOverdue?: number }) {
  const asOf = input.asOf ?? ctx.today;
  const customers = new Map((await ctx.tx.list<Customer>('customer')).map((c) => [c.id, c]));
  const items = (await ctx.tx.list<Invoice>('invoice'))
    .filter((i) => i.issueDate <= asOf)
    .map((i) => invoiceView(i, customers.get(i.customerId), asOf))
    .filter((v) => v.openCents > 0)
    .filter((v) => (input.minDaysOverdue === undefined ? true : v.daysOverdue >= input.minDaysOverdue && v.dueDate < asOf))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number))
    .map(({ lines: _l, payments: _p, ...rest }) => rest);
  return { asOf, count: items.length, totalOpenCents: items.reduce((s, i) => s + i.openCents, 0), items };
}

export async function receivablesByCustomer(ctx: Ctx, input: { asOf?: string }) {
  const { asOf, items } = await listOpenItems(ctx, input);
  const rows = new Map<string, { customerId: string; customerName: string; openCents: number; overdueCents: number; invoices: number }>();
  for (const i of items) {
    const r = rows.get(i.customerId) ?? { customerId: i.customerId, customerName: i.customerName, openCents: 0, overdueCents: 0, invoices: 0 };
    r.openCents += i.openCents;
    if (i.daysOverdue > 0) r.overdueCents += i.openCents;
    r.invoices++;
    rows.set(i.customerId, r);
  }
  const list = [...rows.values()].sort((a, b) => b.openCents - a.openCents);
  return {
    asOf, customers: list,
    totalOpenCents: list.reduce((s, r) => s + r.openCents, 0),
    totalOverdueCents: list.reduce((s, r) => s + r.overdueCents, 0),
  };
}

interface PaymentReminder {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  openCents: number;
  sentAt: string;
}

interface OverdueInvoice {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerContactName: string;
  customerEmail: string;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  openCents: number;
}

/** Common function to find overdue invoices with optional first-reminder requirement */
async function findOverdueInvoices(
  ctx: Ctx,
  asOf: string,
  minDays: number,
  customers: Map<string, Customer>,
  requireFirstReminder?: boolean
): Promise<OverdueInvoice[]> {
  const invoices = await ctx.tx.list<Invoice>('invoice');
  const result: OverdueInvoice[] = [];

  for (const inv of invoices) {
    if (inv.testDraft !== true) continue; // Only test drafts

    const open = openCents(inv);
    if (open === 0) continue; // Skip fully paid invoices

    const daysOverdue = Math.max(0, daysBetween(inv.dueDate, asOf));
    if (daysOverdue < minDays) continue; // Only minDays+ days overdue

    // Check that reminder 1 was already sent if required
    if (requireFirstReminder) {
      const reminder1 = await ctx.tx.get<PaymentReminder>('payment_reminder', `reminder-${inv.id}`);
      if (!reminder1) continue; // Skip if first reminder was not sent
    }

    const customer = customers.get(inv.customerId);
    if (!customer) continue;

    result.push({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      customerId: inv.customerId,
      customerName: customer.name,
      customerContactName: customer.contactName,
      customerEmail: customer.email,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      daysOverdue,
      openCents: open,
    });
  }

  // Sort by days overdue descending
  result.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return result;
}

/** Format date as German locale date string */
function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Format reminder text with personalized greeting and correct structure */
function formatReminderText(r: OverdueInvoice, level: 1 | 2): string {
  const formattedDate = new Date(`${r.dueDate}T00:00:00Z`);
  const dueDateString = formattedDate.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' });

  let text: string;

  if (level === 1) {
    // Level 1: Payment reminder
    text = `Guten Tag ${r.customerContactName},

die Rechnung ${r.invoiceNumber} vom ${formatDate(r.issueDate)} ist fällig seit ${dueDateString} und seit ${r.daysOverdue} Tagen überfällig.

Bitte überweisen Sie den offenen Betrag von ${formatEur(r.openCents)} umgehend.

Mit freundlichen Grüßen,
Ihr Dialograft Team`;
  } else {
    // Level 2: Second reminder (Mahnstufe 2)
    text = `Guten Tag ${r.customerContactName},

trotz unserer Zahlungserinnerung ist die Rechnung ${r.invoiceNumber} vom ${formatDate(r.issueDate)} weiterhin offen. Wir mahnen sie hiermit erneut an. Sie ist fällig seit ${dueDateString} und seit ${r.daysOverdue} Tagen überfällig.

Bitte überweisen Sie den offenen Betrag von ${formatEur(r.openCents)} umgehend.

Mit freundlichen Grüßen,
Ihr Dialograft Team`;
  }

  return text;
}

export async function runPaymentReminders(ctx: Ctx, input: { asOf?: string }, deps: { mailer: { send: (msg: { to: string; subject: string; text: string }) => Promise<unknown> } }) {
  const asOf = input.asOf ?? ctx.today;
  const customers = new Map((await ctx.tx.list<Customer>('customer')).map((c) => [c.id, c]));
  const reminders = await findOverdueInvoices(ctx, asOf, 14, customers);

  const sent: Array<{ invoiceNumber: string; customerEmail: string; daysOverdue: number }> = [];
  const alreadySent: Array<{ invoiceNumber: string }> = [];

  for (const reminder of reminders) {
    // Check if reminder already sent for this invoice
    const existing = await ctx.tx.get<PaymentReminder>('payment_reminder', `reminder-${reminder.invoiceId}`);
    if (existing) {
      alreadySent.push({ invoiceNumber: reminder.invoiceNumber });
      continue;
    }

    // Format the reminder text (level 1)
    const text = formatReminderText(reminder, 1);
    await deps.mailer.send({ to: reminder.customerEmail, subject: `Zahlungserinnerung: Rechnung ${reminder.invoiceNumber}`, text });
    await ctx.tx.audit(ctx.actor, 'payment_reminder.sent', { invoiceId: reminder.invoiceId, invoiceNumber: reminder.invoiceNumber, daysOverdue: reminder.daysOverdue });

    // Record the reminder
    const record: PaymentReminder = {
      id: `reminder-${reminder.invoiceId}`,
      invoiceId: reminder.invoiceId,
      invoiceNumber: reminder.invoiceNumber,
      customerId: reminder.customerId,
      customerName: reminder.customerName,
      customerEmail: reminder.customerEmail,
      issueDate: reminder.issueDate,
      dueDate: reminder.dueDate,
      daysOverdue: reminder.daysOverdue,
      openCents: reminder.openCents,
      sentAt: ctx.now(),
    };
    await ctx.tx.put('payment_reminder', record);
    sent.push({ invoiceNumber: reminder.invoiceNumber, customerEmail: reminder.customerEmail, daysOverdue: reminder.daysOverdue });
  }

  return { asOf, sent, alreadySent, total: reminders.length };
}

export async function runPaymentReminders2(ctx: Ctx, input: { asOf?: string }, deps: { mailer: { send: (msg: { to: string; subject: string; text: string }) => Promise<unknown> } }) {
  const asOf = input.asOf ?? ctx.today;
  const customers = new Map((await ctx.tx.list<Customer>('customer')).map((c) => [c.id, c]));
  const reminders = await findOverdueInvoices(ctx, asOf, 30, customers, true);

  const sent: Array<{ invoiceNumber: string; customerEmail: string; daysOverdue: number }> = [];
  const alreadySent: Array<{ invoiceNumber: string }> = [];

  for (const reminder of reminders) {
    // Check if reminder 2 already sent for this invoice
    const existing = await ctx.tx.get<PaymentReminder>('payment_reminder_2', `reminder2-${reminder.invoiceId}`);
    if (existing) {
      alreadySent.push({ invoiceNumber: reminder.invoiceNumber });
      continue;
    }

    // Format the reminder text (level 2)
    const text = formatReminderText(reminder, 2);
    await deps.mailer.send({ to: reminder.customerEmail, subject: `2. Mahnung: Rechnung ${reminder.invoiceNumber}`, text });
    await ctx.tx.audit(ctx.actor, 'payment_reminder_2.sent', { invoiceId: reminder.invoiceId, invoiceNumber: reminder.invoiceNumber, daysOverdue: reminder.daysOverdue });

    // Record the reminder
    const record: PaymentReminder = {
      id: `reminder2-${reminder.invoiceId}`,
      invoiceId: reminder.invoiceId,
      invoiceNumber: reminder.invoiceNumber,
      customerId: reminder.customerId,
      customerName: reminder.customerName,
      customerEmail: reminder.customerEmail,
      issueDate: reminder.issueDate,
      dueDate: reminder.dueDate,
      daysOverdue: reminder.daysOverdue,
      openCents: reminder.openCents,
      sentAt: ctx.now(),
    };
    await ctx.tx.put('payment_reminder_2', record);
    sent.push({ invoiceNumber: reminder.invoiceNumber, customerEmail: reminder.customerEmail, daysOverdue: reminder.daysOverdue });
  }

  return { asOf, sent, alreadySent, total: reminders.length };
}
