import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/tools/registry.js';

// Mock mailer that tracks sent emails
class MockMailer {
  sent: Array<{ to: string; subject: string; text: string }> = [];

  send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
    return Promise.resolve({ messageId: `msg-${this.sent.length}` });
  }
}

async function setupWithMailer() {
  const { MemoryStore } = await import('../src/store/memory.js');
  const { seed } = await import('../src/cli/seed-data.js');
  const { ArtifactStore } = await import('../src/services/artifacts.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { executeTool } = await import('../src/tools/registry.js');

  const TENANT = 'demo-tenant';
  const owner: Principal = { name: 'test-owner', tenantId: TENANT, permissions: ['billing:read', 'billing:write', 'features:write', 'notifications'] };

  const store = new MemoryStore();
  await store.transaction(TENANT, (tx) => seed(tx));
  const artifacts = new ArtifactStore(await mkdtemp(join(tmpdir(), 'dg-art-')));
  const mailer = new MockMailer();
  const deps: any = { store, artifacts, today: '2026-10-30', mailer };
  const call = async <T = any>(name: string, input: unknown = {}, who: Principal = owner) =>
    (await executeTool(deps, who, name, input)) as { result: T; replayed: boolean; pendingNotifications: { cursor: number; type: string; message: string }[] };
  return { store, artifacts, mailer, deps, call };
}

describe('payment reminders 2 (Mahnstufe 2) tool', () => {

  it('does not send Mahnstufe 2 if first reminder was not sent', async () => {
    const { call } = await setupWithMailer();

    // R-0005 ( issued 2026-10-10, due 2026-10-24) is 6 days overdue, no first reminder
    // R-0007 (issued 2026-10-20, due 2026-11-03) is in the future, no first reminder
    // None of these have first reminder sent, so no Mahnstufe 2 should be sent
    const { result } = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    expect(result.asOf).toBe('2026-10-30');
    expect(result.total).toBe(0);
    expect(result.sent).toHaveLength(0);
    expect(result.alreadySent).toHaveLength(0);
  });

  it('sends Mahnstufe 2 only after Mahnstufe 1 was sent', async () => {
    const { call, store } = await setupWithMailer();

    // First run Mahnstufe 1 reminders
    const firstRun = await call('configure_payment_reminders', { asOf: '2026-10-30' });
    expect(firstRun.result.sent).toHaveLength(4); // 4 invoices are at least 14 days overdue

    // Now run Mahnstufe 2 - should only send for invoices that are 30+ days overdue AND have first reminder
    const { result } = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // R-0002 (57 days overdue) and R-0004 (57 days overdue) should have Mahnstufe 2
    expect(result.total).toBe(2);
    expect(result.sent).toHaveLength(2);
    expect(result.alreadySent).toHaveLength(0);

    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber).sort();
    expect(sentNumbers).toEqual(['R-0002', 'R-0004']);
  });

  it('does not send Mahnstufe 2 for invoices that are only 14-29 days overdue', async () => {
    const { call, store } = await setupWithMailer();

    // First run Mahnstufe 1 reminders
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // R-0003 (15 days overdue) and R-0006 (20 days overdue) have first reminder
    // But they are not 30+ days overdue, so only R-0002 and R-0004 (57 days) qualify
    const { result } = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Only 2 invoices (R-0002, R-0004) are 30+ days overdue AND have first reminder
    expect(result.total).toBe(2);
    expect(result.sent).toHaveLength(2);
    expect(result.alreadySent).toHaveLength(0);

    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber).sort();
    expect(sentNumbers).toEqual(['R-0002', 'R-0004']);
  });

  it('does not send duplicate Mahnstufe 2 emails - idempotency works', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Run Mahnstufe 2
    const firstRun = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });
    expect(firstRun.result.sent).toHaveLength(2);

    const firstRunEmailCount = mailer.sent.length;

    // Second run with different idempotency key - should replay
    const secondRun = await call('configure_payment_reminders_2', { asOf: '2026-10-30', idempotencyKey: 'mahn-2-2026-10-30-v2' });

    expect(mailer.sent.length).toBe(firstRunEmailCount);
    expect(secondRun.result.sent).toHaveLength(0);
    expect(secondRun.result.alreadySent).toHaveLength(2);
  });

  it('records payment_reminder_2 entries', async () => {
    const { call, store } = await setupWithMailer();

    // Check initial state - no payment reminders 2
    const initialReminders = await store.transaction('demo-tenant', async (tx) => {
      return await tx.list('payment_reminder_2');
    });
    expect(initialReminders).toHaveLength(0);

    // Run Mahnstufe 1 reminders first
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Verify reminders were recorded
    const recorded = await store.transaction('demo-tenant', async (tx) => {
      return await tx.list('payment_reminder_2');
    });
    expect(recorded).toHaveLength(2);
  });

  it('default asOf uses reference today (2026-10-30)', async () => {
    const { call } = await setupWithMailer();

    // Run Mahnstufe 1 first
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    const { result } = await call('configure_payment_reminders_2', {});
    expect(result.asOf).toBe('2026-10-30');
  });

  it('calls mailer with correct recipient and content for Mahnstufe 2', async () => {
    const { call, mailer } = await setupWithMailer();

    // Run Mahnstufe 1 first (sends 4 emails)
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    expect(mailer.sent).toHaveLength(4);

    // Run Mahnstufe 2 (sends 2 more emails for 30+ days overdue invoices)
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Total: 4 (Mahnstufe 1) + 2 (Mahnstufe 2) = 6 emails
    expect(mailer.sent).toHaveLength(6);

    // Check that emails were sent to customers with 30+ days overdue invoices that had first reminder
    const emails = mailer.sent.map((e: any) => e.to);
    expect(emails).toContain('jonas@kraemer-maler.invalid'); // R-0002 and R-0004

    // Check that the subject and text contain expected content for 2nd reminder
    const reminder = mailer.sent.find((e: any) => e.subject.includes('2. Mahnung: Rechnung R-0004'));
    expect(reminder).toBeDefined();
    if (reminder) {
      expect(reminder.subject).toBe('2. Mahnung: Rechnung R-0004');
      expect(reminder.text).toContain('erneut an');
      expect(reminder.text).toContain('57 Tagen');
      expect(reminder.text).toContain('offenen Betrag');
    }
  });

  it('excludes fully paid invoices from Mahnstufe 2', async () => {
    const { call } = await setupWithMailer();

    // Run Mahnstufe 1 first
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // R-0001 and R-0008 are fully paid, so they should not appear in Mahnstufe 2
    // (they also don't have first reminder because they were paid before the reminder threshold)
    const { result } = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber);

    expect(sentNumbers).not.toContain('R-0001');
    expect(sentNumbers).not.toContain('R-0008');
  });

  it('sends exactly one Mahnstufe 2 email per qualifying invoice', async () => {
    const { call, mailer } = await setupWithMailer();

    // Run Mahnstufe 1 first
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Run Mahnstufe 2
    const firstRun = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });
    const firstRunEmailCount = mailer.sent.length;

    // Run Mahnstufe 2 again with same idempotency key - should replay
    const secondRun = await call('configure_payment_reminders_2', { asOf: '2026-10-30', idempotencyKey: 'exact-same-key' });

    expect(secondRun.result.sent).toHaveLength(0);
    expect(secondRun.result.alreadySent).toHaveLength(2);
    expect(mailer.sent.length).toBe(firstRunEmailCount);
  });
});
