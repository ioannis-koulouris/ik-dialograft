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

describe('payment reminders tool', () => {
  const TENANT = 'demo-tenant';
  const owner: Principal = { name: 'test-owner', tenantId: TENANT, permissions: ['billing:read', 'billing:write', 'features:write', 'notifications'] };

  async function setupWithMailer() {
    const { MemoryStore } = await import('../src/store/memory.js');
    const { seed } = await import('../src/cli/seed-data.js');
    const { ArtifactStore } = await import('../src/services/artifacts.js');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { executeTool } = await import('../src/tools/registry.js');

    const store = new MemoryStore();
    await store.transaction(TENANT, (tx) => seed(tx));
    const artifacts = new ArtifactStore(await mkdtemp(join(tmpdir(), 'dg-art-')));
    const mailer = new MockMailer();
    const deps: any = { store, artifacts, today: '2026-10-30', mailer };
    const call = async <T = any>(name: string, input: unknown = {}, who: Principal = owner) =>
      (await executeTool(deps, who, name, input)) as { result: T; replayed: boolean; pendingNotifications: { cursor: number; type: string; message: string }[] };
    return { store, artifacts, mailer, deps, call };
  }

  it('sends exactly one reminder email per overdue invoice as of the reference date', async () => {
    const { call, store } = await setupWithMailer();

    const { result } = await call('configure_payment_reminders', { asOf: '2026-10-30' });

    expect(result.asOf).toBe('2026-10-30');
    expect(result.total).toBe(4); // 4 invoices are at least 14 days overdue

    // Check that exactly 4 reminders were sent
    expect(result.sent).toHaveLength(4);
    expect(result.alreadySent).toHaveLength(0);

    // Verify the sent reminders are for the correct invoices
    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber).sort();
    expect(sentNumbers).toEqual(['R-0002', 'R-0003', 'R-0004', 'R-0006']);
  });

  it('does not send duplicate reminders - payment_reminder record prevents resending', async () => {
    const { call, store, mailer } = await setupWithMailer();

    // First run - send reminders
    const firstRun = await call('configure_payment_reminders', { asOf: '2026-10-30' });
    expect(firstRun.result.sent).toHaveLength(4);
    expect(firstRun.result.alreadySent).toHaveLength(0);

    // Verify payment_reminder records were created
    const reminders = await store.transaction('demo-tenant', async (tx) => {
      return await tx.list('payment_reminder');
    });
    expect(reminders).toHaveLength(4);

    // Store the mailer's sent count after first run
    const firstRunEmailCount = mailer.sent.length;

    // Second run - should use idempotency to replay the same result
    // Since we're using a different idempotency key, it will re-execute
    // but the payment_reminder record check should prevent re-sending
    const secondRun = await call('configure_payment_reminders', { asOf: '2026-10-30', idempotencyKey: 'reminders-2026-10-30-v2' });
    
    // The mailer should NOT have sent any new emails (still same count)
    expect(mailer.sent.length).toBe(firstRunEmailCount);
    
    // But it should recognize these as already-reminded invoices
    expect(secondRun.result.sent).toHaveLength(0);
    expect(secondRun.result.alreadySent).toHaveLength(4);
  });

  it('uses the optional asOf parameter correctly', async () => {
    const { call } = await setupWithMailer();

    // With asOf = '2026-10-30', R-0007 (issued 2026-10-20, 14 days due) should NOT be included (only 10 days overdue)
    const { result } = await call('configure_payment_reminders', { asOf: '2026-10-30' });
    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber);

    // R-0007 has dueDate 2026-11-03, which is 4 days in the future from 2026-10-30
    // So it should not be in the list of overdue invoices
    expect(sentNumbers).not.toContain('R-0007');
  });

  it('does not send reminders for fully paid invoices', async () => {
    const { call } = await setupWithMailer();

    // R-0001 and R-0008 are fully paid (see seed-data.ts)
    const { result } = await call('configure_payment_reminders', { asOf: '2026-10-30' });
    const sentNumbers = result.sent.map((s: any) => s.invoiceNumber);

    expect(sentNumbers).not.toContain('R-0001');
    expect(sentNumbers).not.toContain('R-0008');
  });

  it('records payment_reminder entries', async () => {
    const { call, store } = await setupWithMailer();

    // Check initial state - no payment reminders
    const initialReminders = await store.transaction('demo-tenant', async (tx) => {
      return await tx.list('payment_reminder');
    });
    expect(initialReminders).toHaveLength(0);

    // Run reminders
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Verify reminders were recorded
    const recorded = await store.transaction('demo-tenant', async (tx) => {
      return await tx.list('payment_reminder');
    });
    expect(recorded).toHaveLength(4);
  });

  it('default asOf uses reference today (2026-10-30)', async () => {
    const { call } = await setupWithMailer();

    const { result } = await call('configure_payment_reminders', {});
    expect(result.asOf).toBe('2026-10-30');
  });

  it('calls mailer with correct recipient and content', async () => {
    const { call, mailer } = await setupWithMailer();

    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    expect(mailer.sent).toHaveLength(4);
    // Check that emails were sent to customers with overdue invoices
    // R-0002: jonas@kraemer-maler.invalid (57 days overdue)
    // R-0003: buchhaltung@sonnenschein.invalid (15 days overdue)
    // R-0004: buchhaltung@sonnenschein.invalid (57 days overdue)
    // R-0006: praxis@weber-physio.invalid (20 days overdue)
    const emails = mailer.sent.map((e: any) => e.to);
    expect(emails).toContain('jonas@kraemer-maler.invalid');
    expect(emails).toContain('buchhaltung@sonnenschein.invalid');
    expect(emails).toContain('praxis@weber-physio.invalid');
    // mia@lindgren-studio.invalid should NOT be included (no overdue invoices)

    // Check that the subject and text contain expected content
    const reminder = mailer.sent.find((e: any) => e.subject.includes('Rechnung R-0004'));
    expect(reminder).toBeDefined();
    if (reminder) {
      expect(reminder.subject).toBe('Zahlungserinnerung: Rechnung R-0004');
      expect(reminder.text).toContain('57 Tagen');
      expect(reminder.text).toContain('offenen Betrag');
    }
  });
});
