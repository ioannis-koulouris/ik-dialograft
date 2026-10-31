import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('billing tools', () => {
  it('lists invoices overdue by at least 14 days at the reference date', async () => {
    const { call } = await setup();
    const { result } = await call('list_open_items', { minDaysOverdue: 14 });
    expect(result.asOf).toBe('2026-10-30');
    expect(result.items.map((i: any) => [i.number, i.daysOverdue])).toEqual([['R-0004', 57], ['R-0002', 45], ['R-0006', 20], ['R-0003', 15]]);
    const all = await call('list_open_items', {});
    expect(all.result.count).toBe(6); // two seeded invoices are fully paid
  });

  it('reports receivables by customer', async () => {
    const { call } = await setup();
    const { result } = await call('report_receivables_by_customer', {});
    expect(result.customers).toHaveLength(5);
    expect(result.totalOverdueCents).toBeLessThan(result.totalOpenCents);
  });

  it('reports ambiguous customers instead of guessing', async () => {
    const { call } = await setup();
    await expect(call('update_customer_contact', { customer: 'Weber', contactName: 'Neu Person' })).rejects.toMatchObject({ status: 409, code: 'ambiguous_customer' });
    const ok = await call('update_customer_contact', { customer: 'Weber Gartenbau', email: 'neu@weber-garten.invalid' });
    expect(ok.result.email).toBe('neu@weber-garten.invalid');
  });

  it('runs quote -> accepted -> invoice -> partial payment and rejects overpayment', async () => {
    const { call } = await setup();
    const c = await call('create_customer', { name: 'Neue Kundin GmbH', contactName: 'Eva Neu', email: 'eva@neu.invalid' });
    const q = await call('create_quote', { customer: c.result.id, lines: [{ description: 'Workshop', quantity: 2, unitPriceCents: 50000, taxRatePct: 19 }] });
    expect(q.result.totals).toEqual({ netCents: 100000, taxCents: 19000, grossCents: 119000 });
    await expect(call('create_invoice_from_quote', { quote: q.result.number })).rejects.toMatchObject({ code: 'quote_not_accepted' });
    await expect(call('accept_quote', { quote: q.result.number })).rejects.toMatchObject({ status: 400 });
    await call('accept_quote', { quote: q.result.number, confirm: true });
    const inv = await call('create_invoice_from_quote', { quote: q.result.number });
    expect(inv.result).toMatchObject({ number: 'R-0009', dueDate: '2026-11-13', testDraft: true });
    const p = await call('record_payment', { invoice: 'R-0009', amountCents: 19000, reference: 'Teil', confirm: true });
    expect(p.result).toMatchObject({ openCents: 100000, status: 'partially_paid' });
    await expect(call('record_payment', { invoice: 'R-0009', amountCents: 100001, reference: 'zu viel', confirm: true })).rejects.toMatchObject({ code: 'overpayment' });
    const rest = await call('record_payment', { invoice: 'R-0009', amountCents: 100000, reference: 'Rest', confirm: true });
    expect(rest.result.status).toBe('paid');
  });

  it('rejects real email recipients and unknown tenant/permission fields', async () => {
    const { call } = await setup();
    await expect(call('create_customer', { name: 'Echt AG', contactName: 'Max', email: 'max@example.com' })).rejects.toMatchObject({ status: 400 });
    await expect(call('list_open_items', { tenantId: 'other' })).rejects.toMatchObject({ status: 400 });
    await expect(call('search_customers', { query: 'x', permissions: ['admin'] })).rejects.toMatchObject({ status: 400 });
  });

  it('is idempotent with an idempotency key', async () => {
    const { call } = await setup();
    const a = await call('record_payment', { invoice: 'R-0002', amountCents: 100, reference: 'idem', confirm: true, idempotencyKey: 'pay-abc-123' });
    const b = await call('record_payment', { invoice: 'R-0002', amountCents: 100, reference: 'idem', confirm: true, idempotencyKey: 'pay-abc-123' });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
    const inv = await call('get_invoice', { invoice: 'R-0002' });
    expect(inv.result.payments).toHaveLength(1);
  });

  it('separates tenants', async () => {
    const { call, store } = await setup();
    const other = { name: 'x', tenantId: 'other-tenant', permissions: ['billing:read'] as const };
    const r = await call('list_open_items', {}, { ...other, permissions: [...other.permissions] });
    expect(r.result.count).toBe(0);
    expect(await store.transaction('other-tenant', (tx) => tx.list('invoice'))).toHaveLength(0);
  });

  it('returns 403 for missing permissions', async () => {
    const { call } = await setup();
    await expect(call('create_customer', { name: 'Neu', contactName: 'Ne u', email: 'a@b.invalid' }, { name: 'ro', tenantId: 'demo-tenant', permissions: ['billing:read'] })).rejects.toMatchObject({ status: 403 });
  });
});
