import { addDays, priceLine, totals } from '../domain/money.js';
import type { Customer, Invoice, Quote } from '../domain/types.js';
import type { Tx } from '../store/store.js';

/** Fixed demo data relative to the reference date 2026-10-30. Five customers, three accepted quotes, eight invoices. */
export async function seed(tx: Tx, createdAt = '2026-09-01T09:00:00.000Z'): Promise<{ skipped: boolean }> {
  if ((await tx.list('customer')).length > 0) return { skipped: true };
  const customers: Customer[] = [
    ['Bäckerei Sonnenschein', 'Petra Sonnenschein', 'buchhaltung@sonnenschein.invalid'],
    ['Malerbetrieb Krämer', 'Jonas Krämer', 'jonas@kraemer-maler.invalid'],
    ['Physiopraxis Weber', 'Dr. Anna Weber', 'praxis@weber-physio.invalid'],
    ['Weber Gartenbau', 'Lukas Weber', 'info@weber-garten.invalid'],
    ['Studio Lindgren', 'Mia Lindgren', 'mia@lindgren-studio.invalid'],
  ].map(([name, contactName, email], i) => ({ id: `cust-${i + 1}`, number: `K-${String(i + 1).padStart(4, '0')}`, name: name!, contactName: contactName!, email: email!, createdAt }));

  const q = (n: number, customerId: string, issueDate: string, lines: Parameters<typeof priceLine>[0][]): Quote => {
    const priced = lines.map(priceLine);
    return { id: `quote-${n}`, number: `A-${String(n).padStart(4, '0')}`, customerId, issueDate, lines: priced, totals: totals(priced), status: 'accepted', acceptedAt: `${issueDate}T12:00:00.000Z` };
  };
  const quotes = [
    q(1, 'cust-1', '2026-07-01', [{ description: 'Website-Wartung (Monat)', quantity: 1, unitPriceCents: 45000, taxRatePct: 19 }]),
    q(2, 'cust-2', '2026-07-15', [{ description: 'Beratung Digitalisierung', quantity: 6, unitPriceCents: 9500, taxRatePct: 19 }, { description: 'Fachbuch', quantity: 1, unitPriceCents: 3990, taxRatePct: 7 }]),
    q(3, 'cust-3', '2026-08-01', [{ description: 'Terminbuchung einrichten', quantity: 1, unitPriceCents: 120000, taxRatePct: 19 }]),
  ];

  // [quote, customer, issueDate, termDays, paid fraction]
  const plan: [Quote, string, string, number, 'none' | 'part' | 'full'][] = [
    [quotes[0]!, 'cust-1', '2026-08-01', 14, 'full'],
    [quotes[0]!, 'cust-1', '2026-09-01', 14, 'none'],     // 45 days overdue
    [quotes[0]!, 'cust-1', '2026-10-01', 14, 'part'],     // 15 days overdue, partially paid
    [quotes[1]!, 'cust-2', '2026-08-20', 14, 'none'],     // 57 days overdue
    [quotes[1]!, 'cust-4', '2026-10-10', 14, 'none'],     // 6 days overdue
    [quotes[2]!, 'cust-3', '2026-09-10', 30, 'part'],     // 20 days overdue, partially paid
    [quotes[2]!, 'cust-5', '2026-10-20', 14, 'none'],     // not yet due
    [quotes[1]!, 'cust-5', '2026-09-05', 14, 'full'],
  ];
  const invoices: Invoice[] = plan.map(([quote, customerId, issueDate, term, paid], i) => {
    const gross = quote.totals.grossCents;
    const amount = paid === 'full' ? gross : paid === 'part' ? Math.floor(gross / 2) : 0;
    return {
      id: `inv-${i + 1}`, number: `R-${String(i + 1).padStart(4, '0')}`, customerId, quoteId: quote.id,
      issueDate, dueDate: addDays(issueDate, term), lines: quote.lines, totals: quote.totals,
      payments: amount ? [{ id: `pay-${i + 1}`, date: addDays(issueDate, 10), amountCents: amount, reference: `Überweisung R-${String(i + 1).padStart(4, '0')}` }] : [],
      testDraft: true,
    };
  });

  for (const c of customers) await tx.put('customer', c);
  for (const x of quotes) await tx.put('quote', x);
  for (const x of invoices) await tx.put('invoice', x);
  // Continue numbering after the seed.
  for (const [prefix, count] of [['K', customers.length], ['A', quotes.length], ['R', invoices.length]] as const) {
    for (let i = 0; i < count; i++) await tx.nextSeq(prefix);
  }
  await tx.audit('seed', 'seed.applied', { customers: customers.length, quotes: quotes.length, invoices: invoices.length });
  return { skipped: false };
}
