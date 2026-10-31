import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('export_open_items_csv', () => {
  it('exports open items as RFC 4180 compliant CSV with German formatting', async () => {
    const { call, artifacts, store } = await setup();

    // Create a customer with semicolon in name
    await store.transaction('demo-tenant', async (tx) => {
      await tx.put('customer', {
        id: 'cust-semicolon',
        number: 'K-SEMI',
        name: 'Müller; Söhne GmbH',
        contactName: 'Hans Meier',
        email: 'kontakt@mueller.invalid',
        createdAt: '2026-01-01',
      });
      await tx.put('invoice', {
        id: 'inv-semicolon',
        number: 'R-SEMI-001',
        customerId: 'cust-semicolon',
        quoteId: 'quote-1',
        issueDate: '2025-12-01',
        dueDate: '2025-12-15',
        lines: [
          { description: 'Produkt A', quantity: 2, unitPriceCents: 5000, taxRatePct: 19, netCents: 10000, taxCents: 1900, grossCents: 11900 },
        ],
        totals: { netCents: 10000, taxCents: 1900, grossCents: 11900 },
        payments: [{ id: 'pay-semi', date: '2025-12-10', amountCents: 3900, reference: 'Anzahlung' }],
        testDraft: true,
      });
    });

    // Create a customer with quote in name
    await store.transaction('demo-tenant', async (tx) => {
      await tx.put('customer', {
        id: 'cust-quote',
        number: 'K-QUOTE',
        name: 'Krämer, "Die Backstube"',
        contactName: 'Anna Bürger',
        email: 'info@kraemer.invalid',
        createdAt: '2026-01-01',
      });
      await tx.put('invoice', {
        id: 'inv-quote',
        number: 'R-QUOTE-001',
        customerId: 'cust-quote',
        quoteId: 'quote-2',
        issueDate: '2025-11-15',
        dueDate: '2025-11-29',
        lines: [
          { description: 'Beratung "Strategie"', quantity: 5, unitPriceCents: 12000, taxRatePct: 19, netCents: 60000, taxCents: 11400, grossCents: 71400 },
        ],
        totals: { netCents: 60000, taxCents: 11400, grossCents: 71400 },
        payments: [],
        testDraft: true,
      });
    });

    const { result } = await call('export_open_items_csv', { asOf: '2026-01-20' });
    const exportResult = result as { exportId: string; fileName: string; sizeBytes: number; downloadPath: string };

    const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', exportResult.exportId));
    expect(file).toBeDefined();
    expect(file.kind).toBe('open_items_csv');
    expect(file.fileName).toBe('offene-posten-2026-01-20-' + exportResult.exportId.slice(0, 8) + '.csv');

    const buf = await readFile(await artifacts.resolveForRead(file.relPath));
    const csvContent = buf.toString('utf8');

    // Check UTF-8 BOM is present
    expect(csvContent.charCodeAt(0)).toBe(0xfeff);

    const contentWithoutBom = csvContent.slice(1);
    const lines = contentWithoutBom.split('\r\n');

    // Check header
    expect(lines[0]).toBe('Rechnungsnummer;Kunde;Rechnungsdatum;Fälligkeitsdatum;Brutto;bereits bezahlt;offener Betrag;Tage überfällig');

    // Filter to get only the data rows
    const dataLines = lines.filter((l, i) => i > 0 && l.length > 0);
    expect(dataLines.length).toBeGreaterThan(0);

    // Find the line for customer with semicolon
    const supplierLine = dataLines.find((l) => l.includes('Müller; Söhne'));
    expect(supplierLine).toBeDefined();
    expect(supplierLine).toContain('"Müller; Söhne GmbH"'); // Quoted because of semicolon

    // Find the line for customer with quote
    const bakeryLine = dataLines.find((l) => l.includes('Krämer'));
    expect(bakeryLine).toBeDefined();
    // RFC 4180: double quotes inside quoted fields are doubled
    expect(bakeryLine).toContain('"Krämer, ""Die Backstube"""'); // Quoted and escaped (doubled quotes)

    // Verify German date format (DD.MM.YYYY)
    expect(supplierLine).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('filters by minDaysOverdue', async () => {
    const { call, artifacts, store } = await setup();

    // Update an existing invoice to be only slightly overdue
    await store.transaction('demo-tenant', async (tx) => {
      const inv = await tx.get<any>('invoice', 'R-0004');
      if (inv) {
        await tx.put('invoice', { ...inv, issueDate: '2026-01-10', dueDate: '2026-01-20' });
      }
    });

    const result1 = await call('export_open_items_csv', { asOf: '2026-01-25', minDaysOverdue: 10 });
    const exportResult1 = result1.result as { exportId: string; fileName: string; sizeBytes: number; downloadPath: string };
    const file1 = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', exportResult1.exportId));
    const buf1 = await readFile(await artifacts.resolveForRead(file1.relPath));
    const lines1 = buf1.toString('utf8').slice(1).split('\r\n').filter((l, i) => i > 0 && l.length > 0);
    // Should only include invoices with 10+ days overdue
    expect(lines1.length).toBeLessThanOrEqual(2); // There may be a few highly overdue invoices from seed data

    const result2 = await call('export_open_items_csv', { asOf: '2026-01-25', minDaysOverdue: 0 });
    const exportResult2 = result2.result as { exportId: string; fileName: string; sizeBytes: number; downloadPath: string };
    const file2 = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', exportResult2.exportId));
    const buf2 = await readFile(await artifacts.resolveForRead(file2.relPath));
    const lines2 = buf2.toString('utf8').slice(1).split('\r\n').filter((l, i) => i > 0 && l.length > 0);
    // With no filter, we should have all open items
    expect(lines2.length).toBeGreaterThanOrEqual(lines1.length);
  });

  it('escapes customer names with newlines', async () => {
    const { call, artifacts, store } = await setup();

    // Create customer with newline in name
    await store.transaction('demo-tenant', async (tx) => {
      await tx.put('customer', {
        id: 'cust-newline',
        number: 'K-NEWLINE',
        name: 'Firma\nmit\nZeilenumbruch',
        contactName: 'Kontakt',
        email: 'newline@test.invalid',
        createdAt: '2024-01-01',
      });
      await tx.put('invoice', {
        id: 'inv-newline',
        number: 'R-NEWLINE',
        customerId: 'cust-newline',
        quoteId: 'quote-1',
        issueDate: '2025-12-01',
        dueDate: '2025-12-15',
        lines: [
          { description: 'Item', quantity: 1, unitPriceCents: 1000, taxRatePct: 19, netCents: 1000, taxCents: 190, grossCents: 1190 },
        ],
        totals: { netCents: 1000, taxCents: 190, grossCents: 1190 },
        payments: [],
        testDraft: true,
      });
    });

    const { result } = await call('export_open_items_csv', { asOf: '2026-01-01' });
    const exportResult = result as { exportId: string; fileName: string; sizeBytes: number; downloadPath: string };
    const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', exportResult.exportId));
    const buf = await readFile(await artifacts.resolveForRead(file.relPath));
    const csvContent = buf.toString('utf8');

    // Customer name with newline must be quoted
    expect(csvContent).toContain('"Firma\nmit\nZeilenumbruch"');
  });

  it('provides all columns in correct order with proper formatting', async () => {
    const { call, artifacts, store } = await setup();

    // Create a test invoice with known data
    await store.transaction('demo-tenant', async (tx) => {
      await tx.put('customer', {
        id: 'cust-format',
        number: 'K-FORMAT',
        name: 'Format Test KG',
        contactName: 'Test',
        email: 'format@test.invalid',
        createdAt: '2026-01-01',
      });
      await tx.put('invoice', {
        id: 'inv-format',
        number: 'R-FORMAT',
        customerId: 'cust-format',
        quoteId: 'quote-1',
        issueDate: '2025-12-01',
        dueDate: '2025-12-15',
        lines: [
          { description: 'Item', quantity: 1, unitPriceCents: 10000, taxRatePct: 19, netCents: 10000, taxCents: 1900, grossCents: 11900 },
        ],
        totals: { netCents: 10000, taxCents: 1900, grossCents: 11900 },
        payments: [{ id: 'pay-test', date: '2025-12-10', amountCents: 4000, reference: 'Teilzahlung' }],
        testDraft: true,
      });
    });

    const { result } = await call('export_open_items_csv', { asOf: '2026-01-01' });
    const exportResult = result as { exportId: string; fileName: string; sizeBytes: number; downloadPath: string };
    const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', exportResult.exportId));
    const buf = await readFile(await artifacts.resolveForRead(file.relPath));
    const content = buf.toString('utf8').slice(1); // Remove BOM
    const lines = content.split('\r\n');
    const header = lines[0];
    // Find the data line for our test customer
    const dataLine = lines.find((l, i) => i > 0 && l.length > 0 && l.includes('Format Test'));
    expect(dataLine).toBeDefined();

    // Parse header to verify column order
    const columns = header?.split(';') ?? [];
    expect(columns).toEqual([
      'Rechnungsnummer',
      'Kunde',
      'Rechnungsdatum',
      'Fälligkeitsdatum',
      'Brutto',
      'bereits bezahlt',
      'offener Betrag',
      'Tage überfällig',
    ]);

    const values = dataLine?.split(';') ?? [];
    expect(values[0]).toBe('R-FORMAT'); // Rechnungsnummer
    expect(values[1]).toBe('Format Test KG'); // Kunde
    expect(values[2]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/); // Rechnungsdatum TT.MM.YYYY
    expect(values[3]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/); // Fälligkeitsdatum TT.MM.YYYY
    expect(values[4]).toBe('119,00'); // Brutto 11900 cents
    expect(values[5]).toBe('40,00'); // bereits bezahlt 4000 cents
    expect(values[6]).toBe('79,00'); // offener Betrag 7900 cents
  });

  it('amounts match list_open_items report', async () => {
    const { call, artifacts, store } = await setup();

    const openItemsCall = await call('list_open_items', { asOf: '2026-10-30' });
    const csvCall = await call('export_open_items_csv', { asOf: '2026-10-30' }) as { result: { exportId: string; fileName: string; sizeBytes: number; downloadPath: string }; replayed: boolean; pendingNotifications: any[] };
    
    // Assert openItemsResult has the expected structure
    expect(openItemsCall.result).toHaveProperty('count');
    expect(openItemsCall.result).toHaveProperty('totalOpenCents');
    expect(openItemsCall.result).toHaveProperty('items');
    expect(openItemsCall.result).toHaveProperty('asOf');
    
    const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', csvCall.result.exportId));
    const buf = await readFile(await artifacts.resolveForRead(file.relPath));
    const csvContent = buf.toString('utf8').slice(1);
    const lines = csvContent.split('\r\n');
    const dataLines = lines.filter((l, i) => i > 0 && l.length > 0);

    // Verify that we have the same number of open items
    expect(dataLines.length).toBe(openItemsCall.result.count);

    // Verify total open amount matches
    let csvTotalOpen = 0;
    for (const line of dataLines) {
      const values = line.split(';');
      const openValue = values[6];
      if (openValue) {
        const openAmount = parseFloat(openValue.replace(',', '.'));
        csvTotalOpen += openAmount;
      }
    }

    expect(csvTotalOpen).toBeCloseTo(openItemsCall.result.totalOpenCents / 100, 2);
  });
});
