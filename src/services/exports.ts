import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatEur } from '../domain/money.js';
import type { Customer, ExportFile } from '../domain/types.js';
import type { ArtifactStore } from './artifacts.js';
import { getInvoice, listOpenItems } from './billing.js';
import type { Ctx } from './context.js';

function pdfBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Dialograft Demo', Producer: 'Dialograft' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

const DEMO_NOTE = 'DEMO – Testentwurf, kein Buchhaltungsbeleg.';

async function persist(ctx: Ctx, store: ArtifactStore, kind: ExportFile['kind'], base: string, ext: string, data: Buffer) {
  const id = ctx.newId();
  const fileName = `${base}-${id.slice(0, 8)}.${ext}`;
  const { relPath, sizeBytes } = await store.write(ctx.tx.tenantId, fileName, data);
  const file: ExportFile = { id, kind, fileName, relPath, sizeBytes, createdAt: ctx.now() };
  await ctx.tx.put('export', file);
  await ctx.tx.audit(ctx.actor, 'export.created', { id, kind });
  return { exportId: id, fileName, sizeBytes, downloadPath: `/v1/files/${id}` };
}

export async function exportInvoicePdf(ctx: Ctx, store: ArtifactStore, ref: string) {
  const inv = await getInvoice(ctx, ref);
  const customer = await ctx.tx.get<Customer>('customer', inv.customerId);
  const data = await pdfBuffer((doc) => {
    doc.fontSize(9).fillColor('#b00').text(DEMO_NOTE).fillColor('#000').moveDown();
    doc.fontSize(18).text(`Rechnungsentwurf ${inv.number}`).moveDown(0.5);
    doc.fontSize(10).text(`${customer?.name ?? ''}\n${customer?.contactName ?? ''}\n${customer?.email ?? ''}`).moveDown();
    doc.text(`Rechnungsdatum: ${inv.issueDate}    Fällig: ${inv.dueDate}`).moveDown();
    for (const l of inv.lines) {
      doc.text(`${l.quantity} × ${l.description} à ${formatEur(l.unitPriceCents)} (USt ${l.taxRatePct} %)`, { continued: true })
        .text(formatEur(l.netCents), { align: 'right' });
    }
    doc.moveDown().text(`Netto: ${formatEur(inv.totals.netCents)}`, { align: 'right' })
      .text(`USt: ${formatEur(inv.totals.taxCents)}`, { align: 'right' })
      .text(`Brutto: ${formatEur(inv.totals.grossCents)}`, { align: 'right' })
      .text(`Bezahlt: ${formatEur(inv.paidCents)}`, { align: 'right' })
      .text(`Offen: ${formatEur(inv.openCents)}`, { align: 'right' });
  });
  return persist(ctx, store, 'invoice_pdf', `rechnung-${inv.number}`, 'pdf', data);
}

export async function exportOpenItemsPdf(ctx: Ctx, store: ArtifactStore, input: { asOf?: string; minDaysOverdue?: number }) {
  const report = await listOpenItems(ctx, input);
  const data = await pdfBuffer((doc) => {
    doc.fontSize(9).fillColor('#b00').text(DEMO_NOTE).fillColor('#000').moveDown();
    doc.fontSize(16).text(`Offene Posten zum ${report.asOf}`).moveDown();
    doc.fontSize(10);
    for (const i of report.items) {
      doc.text(`${i.number}  ${i.customerName}  fällig ${i.dueDate}  ${i.daysOverdue} Tage überfällig`, { continued: true })
        .text(formatEur(i.openCents), { align: 'right' });
    }
    doc.moveDown().fontSize(11).text(`Summe offen: ${formatEur(report.totalOpenCents)}`, { align: 'right' });
  });
  return persist(ctx, store, 'open_items_pdf', `offene-posten-${report.asOf}`, 'pdf', data);
}

export async function exportOpenItemsCsv(ctx: Ctx, store: ArtifactStore, input: { asOf?: string; minDaysOverdue?: number }) {
  const report = await listOpenItems(ctx, input);
  
  // Helper to escape a field according to RFC 4180
  const escapeField = (value: string): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Need to quote if contains semicolon, double quote, or newline
    if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      // Double any double quotes
      const escaped = str.replace(/"/g, '""');
      return `"${escaped}"`;
    }
    return str;
  };

  // Helper to format date as DD.MM.YYYY
  const formatGermanDate = (isoDate: string): string => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();
    return `${day}.${month}.${year}`;
  };

  // Helper to format number with comma as decimal separator
  const formatEurCsv = (cents: number): string => {
    const euros = (cents / 100).toFixed(2);
    return euros.replace('.', ',');
  };

  const header = [
    'Rechnungsnummer',
    'Kunde',
    'Rechnungsdatum',
    'Fälligkeitsdatum',
    'Brutto',
    'bereits bezahlt',
    'offener Betrag',
    'Tage überfällig',
  ].join(';');

  const lines = report.items.map((i) => {
    const gross = i.totals.grossCents;
    const paid = gross - i.openCents;
    const row = [
      escapeField(i.number),
      escapeField(i.customerName),
      escapeField(formatGermanDate(i.issueDate)),
      escapeField(formatGermanDate(i.dueDate)),
      escapeField(formatEurCsv(gross)),
      escapeField(formatEurCsv(paid)),
      escapeField(formatEurCsv(i.openCents)),
      escapeField(String(i.daysOverdue)),
    ].join(';');
    return row;
  });

  const csvContent = [header, ...lines].join('\r\n');
  
  // Add UTF-8 BOM so Excel recognizes the encoding correctly
  const data = Buffer.from('\uFEFF' + csvContent, 'utf8');
  
  return persist(ctx, store, 'open_items_csv', `offene-posten-${report.asOf}`, 'csv', data);
}

export async function exportOpenItemsXlsx(ctx: Ctx, store: ArtifactStore, input: { asOf?: string; minDaysOverdue?: number }) {
  const report = await listOpenItems(ctx, input);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dialograft (Demo)';
  const ws = wb.addWorksheet('Offene Posten');
  ws.columns = [
    { header: 'Rechnung', key: 'number', width: 14 },
    { header: 'Kunde', key: 'customer', width: 28 },
    { header: 'Fällig', key: 'due', width: 12 },
    { header: 'Tage überfällig', key: 'days', width: 16 },
    { header: 'Brutto (EUR)', key: 'gross', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Offen (EUR)', key: 'open', width: 14, style: { numFmt: '#,##0.00' } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const i of report.items) {
    ws.addRow({ number: i.number, customer: i.customerName, due: i.dueDate, days: i.daysOverdue, gross: i.totals.grossCents / 100, open: i.openCents / 100 });
  }
  const last = report.items.length + 1;
  const sum = ws.addRow({ number: 'Summe' });
  sum.getCell('gross').value = { formula: `SUM(E2:E${last})`, result: report.items.reduce((s, i) => s + i.totals.grossCents, 0) / 100 };
  sum.getCell('open').value = { formula: `SUM(F2:F${last})`, result: report.totalOpenCents / 100 };
  sum.font = { bold: true };
  ws.addRow([]);
  ws.addRow([DEMO_NOTE]);
  const data = Buffer.from(await wb.xlsx.writeBuffer());
  return persist(ctx, store, 'open_items_xlsx', `offene-posten-${report.asOf}`, 'xlsx', data);
}
