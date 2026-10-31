import { readFile } from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('exports', () => {
  it('writes a real xlsx with numeric amounts and sum formulas', async () => {
    const { call, artifacts, store } = await setup();
    const { result } = await call('export_open_items_xlsx', { minDaysOverdue: 14 });
    const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', result.exportId));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await artifacts.resolveForRead(file.relPath));
    const ws = wb.getWorksheet('Offene Posten')!;
    expect(ws.getCell('A2').value).toBe('R-0004');
    expect(typeof ws.getCell('F2').value).toBe('number');
    const sum = ws.getCell('F6').value as { formula: string; result: number };
    expect(sum.formula).toBe('SUM(F2:F5)');
    const open = await call('list_open_items', { minDaysOverdue: 14 });
    expect(sum.result).toBeCloseTo(open.result.totalOpenCents / 100, 2);
  });

  it('writes PDFs', async () => {
    const { call, artifacts, store } = await setup();
    for (const [tool, input] of [['export_invoice_pdf', { invoice: 'R-0003' }], ['export_open_items_pdf', {}]] as const) {
      const { result } = await call(tool, input);
      const file = await store.transaction('demo-tenant', (tx) => tx.get<any>('export', result.exportId));
      const buf = await readFile(await artifacts.resolveForRead(file.relPath));
      expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    }
  });

  it('refuses traversal and symlinks', async () => {
    const { artifacts } = await setup();
    await expect(artifacts.resolveForRead('../etc/passwd')).rejects.toThrow();
    await symlink('/etc/hosts', join(artifacts.root, 'link.pdf'));
    await expect(artifacts.resolveForRead('link.pdf')).rejects.toThrow();
  });
});

describe('orphaned exports', () => {
  it('finds only old, unreferenced files of the tenant and deletes them on request', async () => {
    const { call, artifacts, store } = await setup();
    await call('export_open_items_pdf', {});
    await artifacts.write('demo-tenant', 'orphan.pdf', Buffer.from('%PDF'));
    const referenced = await store.transaction('demo-tenant', async (tx) => new Set((await tx.list<any>('export')).map((e) => e.relPath)));
    const later = Date.now() + 2 * 60 * 60_000;
    expect(await artifacts.sweepOrphans('demo-tenant', referenced, { minAgeMs: 60 * 60_000, dryRun: true })).toEqual([]); // too young
    const dry = await artifacts.sweepOrphans('demo-tenant', referenced, { minAgeMs: 60 * 60_000, dryRun: true, now: later });
    expect(dry).toEqual([join('demo-tenant', 'orphan.pdf')]);
    await artifacts.sweepOrphans('demo-tenant', referenced, { minAgeMs: 60 * 60_000, dryRun: false, now: later });
    await expect(artifacts.resolveForRead(join('demo-tenant', 'orphan.pdf'))).rejects.toThrow();
    for (const rel of referenced) expect(await artifacts.resolveForRead(rel)).toBeTruthy();
    await expect(artifacts.sweepOrphans('../x', referenced, { minAgeMs: 0, dryRun: true })).rejects.toThrow();
  });
});
