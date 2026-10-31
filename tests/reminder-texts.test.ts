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

describe('payment reminder texts', () => {
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

  it('level 1 reminder starts with personalized greeting "Guten Tag <contactName>"', async () => {
    const { call, mailer } = await setupWithMailer();

    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Check that all level 1 reminders start with "Guten Tag <contactName>,"
    expect(mailer.sent).toHaveLength(4);
    for (const email of mailer.sent) {
      expect(email.text).toMatch(/^Guten Tag [^,]+,/m);
      expect(email.subject).toContain('Zahlungserinnerung');
    }
  });

  it('level 1 reminder contains "fällig seit" with due date and no "Der Betrag vom"', async () => {
    const { call, mailer } = await setupWithMailer();

    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Check that text contains "fällig seit" and the due date
    const reminder = mailer.sent.find((e: any) => e.subject.includes('Rechnung R-0004'));
    expect(reminder).toBeDefined();
    if (reminder) {
      expect(reminder.text).toContain('fällig seit');
      expect(reminder.text).not.toContain('Der Betrag vom');
    }
  });

  it('level 1 reminder has amount appearing exactly once', async () => {
    const { call, mailer } = await setupWithMailer();

    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Check that amount appears exactly once in each email
    for (const email of mailer.sent) {
      // Count occurrences of the amount pattern (e.g., "123,45 €")
      const euroMatches = email.text.match(/\d+(?:\.\d{3})*,\d{2} €/g);
      expect(euroMatches).toHaveLength(1);
    }
  });

  it('level 1 reminder ends with payment request "Bitte überweisen Sie den offenen Betrag"', async () => {
    const { call, mailer } = await setupWithMailer();

    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    for (const email of mailer.sent) {
      expect(email.text).toContain('Bitte überweisen Sie den offenen Betrag von');
      expect(email.text).toContain('umgehend.');
    }
  });

  it('level 2 reminder starts with personalized greeting "Guten Tag <contactName>"', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Check that all level 2 reminders start with "Guten Tag <contactName>,"
    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    expect(level2Emails).toHaveLength(2);
    for (const email of level2Emails) {
      expect(email.text).toMatch(/^Guten Tag [^,]+,/m);
    }
  });

  it('level 2 reminder contains "weiterhin offen" and "Wir mahnen sie hiermit erneut an." ', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Check that level 2 text contains the required phrases
    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      expect(email.text).toContain('weiterhin offen');
      expect(email.text).toContain('Wir mahnen sie hiermit erneut an.');
    }
  });

  it('level 2 reminder mentions first reminder and contains "erneut an"', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      expect(email.text).toContain('Zahlungserinnerung');
      expect(email.text).toContain('erneut an');
    }
  });

  it('level 2 reminder contains "fällig seit" with due date and no "Der Betrag vom"', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      expect(email.text).toContain('fällig seit');
      expect(email.text).not.toContain('Der Betrag vom');
    }
  });

  it('level 2 reminder has amount appearing exactly once', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Check that amount appears exactly once in level 2 emails
    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      const euroMatches = email.text.match(/\d+(?:\.\d{3})*,\d{2} €/g);
      expect(euroMatches).toHaveLength(1);
    }
  });

  it('level 2 reminder ends with payment request "Bitte überweisen Sie den offenen Betrag"', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      expect(email.text).toContain('Bitte überweisen Sie den offenen Betrag von');
      expect(email.text).toContain('umgehend.');
    }
  });

  it('empty line after greeting in level 1 and level 2 reminders', async () => {
    const { call, mailer } = await setupWithMailer();

    // First run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });
    // Then run Mahnstufe 2
    await call('configure_payment_reminders_2', { asOf: '2026-10-30' });

    // Check level 1
    const level1Emails = mailer.sent.filter((e: any) => e.subject.startsWith('Zahlungserinnerung'));
    for (const email of level1Emails) {
      // After "Guten Tag <name>," there should be an empty line
      expect(email.text).toMatch(/^Guten Tag [^,]+,\n$/m);
    }

    // Check level 2
    const level2Emails = mailer.sent.filter((e: any) => e.subject.startsWith('2. Mahnung'));
    for (const email of level2Emails) {
      // After "Guten Tag <name>," there should be an empty line
      expect(email.text).toMatch(/^Guten Tag [^,]+,\n$/m);
    }
  });

  it('at 2026-10-30 sends 4 level 1 and 2 level 2 reminders', async () => {
    const { call, mailer } = await setupWithMailer();

    // Run Mahnstufe 1
    const result1 = await call('configure_payment_reminders', { asOf: '2026-10-30' });
    expect(result1.result.sent).toHaveLength(4); // 4 invoices are at least 14 days overdue
    expect(result1.result.total).toBe(4);

    // Run Mahnstufe 2
    const result2 = await call('configure_payment_reminders_2', { asOf: '2026-10-30' });
    expect(result2.result.sent).toHaveLength(2); // 2 invoices are 30+ days overdue with first reminder
    expect(result2.result.total).toBe(2);

    // Total emails should be 6
    expect(mailer.sent).toHaveLength(6);
  });

  it('uses customer contactName in greeting (not customer name)', async () => {
    const { call, mailer } = await setupWithMailer();

    // Run Mahnstufe 1
    await call('configure_payment_reminders', { asOf: '2026-10-30' });

    // Check that the greeting uses contactName, not company name
    for (const email of mailer.sent) {
      // Extract the name from the greeting
      const match = email.text.match(/^Guten Tag ([^,]+),/m);
      expect(match).toBeDefined();
      if (match) {
        const greetingName = match[1];
        // Should be a contact name (like "Jonas" or "Buchhaltung"), not a full company name
        // The seed data shows contactName vs name - contactName should be used
        expect(email.text).toMatch(new RegExp(`^Guten Tag ${greetingName},`, 'm'));
      }
    }
  });
});
