import { describe, expect, it } from 'vitest';
import { HANDOVER_MESSAGE } from '../src/services/features.js';
import { KNOWN_GAPS } from '../src/tools/registry.js';
import { handlers, runOnce, type WorkerDeps } from '../src/worker/handlers.js';
import { FakeAssessor, FakeGitHub, FakeRunner, goodAssessment, okRun } from './fakes.js';
import { setup } from './helpers.js';

const reminderScope = {
  goal: 'Kunden automatisch an überfällige Rechnungen erinnern',
  trigger: '14 Tage nach Fälligkeit',
  behavior: ['Einmalige E-Mail an den Rechnungskontakt mit offenem Restbetrag'],
  exceptions: ['Keine Erinnerung nach vollständiger Zahlung', 'Kein Doppelversand'],
  acceptanceCriteria: ['Prüflauf mit Stichtag versendet genau eine Testmail je fälliger Rechnung'],
};

async function world() {
  const s = await setup();
  const github = new FakeGitHub();
  const assessor = new FakeAssessor();
  const runner = new FakeRunner(okRun);
  const wd: WorkerDeps = { store: s.store, github, assessor, runner, pricing: { ratePerHourCents: 10000, riskSurchargePct: 20 }, today: '2026-10-30' };
  const drain = async () => { while (await runOnce(wd, 'test-worker')); };
  return { ...s, github, assessor, runner, wd, drain };
}

async function toOffer(w: Awaited<ReturnType<typeof world>>) {
  const d = await w.call('draft_feature_request', { title: 'Automatische Zahlungserinnerungen', request: 'Erinnerungen nach 14 Tagen', scope: { trigger: '14 Tage nach Fälligkeit' } });
  const u = await w.call('update_feature_scope', { featureRequestId: d.result.id, scope: reminderScope });
  await w.call('confirm_feature_scope', { featureRequestId: d.result.id, scopeVersion: u.result.scopeVersion, confirm: true });
  await w.drain();
  return (await w.call('get_feature_request', { featureRequestId: d.result.id })).result;
}

describe('feature request workflow', () => {
  it('reports known gaps exactly when their resolving tool is not registered', async () => {
    const { call } = await setup();
    const { result } = await call('list_capabilities');
    const names = result.tools.map((t: any) => t.name);
    for (const gap of KNOWN_GAPS) {
      expect(result.knownGaps.some((g: any) => g.id === gap.id)).toBe(!names.includes(gap.resolvedByTool));
    }
  });

  it('keeps already given details and lists only missing fields; proposals block confirmation', async () => {
    const { call } = await setup();
    const d = await call('draft_feature_request', { title: 'Automatische Zahlungserinnerungen', request: 'Bitte nach 14 Tagen erinnern', scope: { trigger: '14 Tage nach Fälligkeit' } });
    expect(d.result.scope.trigger).toBe('14 Tage nach Fälligkeit');
    expect(d.result.missing).toEqual(['goal', 'behavior', 'acceptanceCriteria']);
    const u = await call('update_feature_scope', { featureRequestId: d.result.id, scope: { ...reminderScope, decisions: [{ topic: 'Absender', answer: 'demo@dialograft.invalid', status: 'proposed' }, { topic: 'Mahngebühr', answer: '', status: 'unknown' }] } });
    expect(u.result.missing).toEqual(['decision:Absender']);
    expect(u.result.scope.openQuestions).toContain('Mahngebühr');
    await expect(call('confirm_feature_scope', { featureRequestId: d.result.id, scopeVersion: u.result.scopeVersion, confirm: true })).rejects.toMatchObject({ status: 400 });
    const u2 = await call('update_feature_scope', { featureRequestId: d.result.id, scope: { decisions: [{ topic: 'Absender', answer: 'demo@dialograft.invalid', status: 'confirmed' }] } });
    await expect(call('confirm_feature_scope', { featureRequestId: d.result.id, scopeVersion: u.result.scopeVersion, confirm: true })).rejects.toMatchObject({ code: 'stale_scope' });
    const c = await call('confirm_feature_scope', { featureRequestId: d.result.id, scopeVersion: u2.result.scopeVersion, confirm: true });
    expect(c.result.status).toBe('scope_confirmed');
    expect(c.pendingNotifications.map((n) => n.type)).toContain('feature.scope_confirmed');
  });

  it('assesses, prices deterministically, revises, accepts and opens a draft PR', async () => {
    const w = await world();
    const fr = await toOffer(w);
    expect(fr.status).toBe('offer_ready');
    expect(fr.ticket).toMatchObject({ number: 1, label: 'auto-implement' });
    expect(w.github.issues.get(1)!.label).toBe('auto-implement');
    // 4–8 h at 100 EUR, +20 % on the upper bound.
    expect(fr.currentOffer).toMatchObject({ version: 1, lowCents: 40000, highCents: 96000, ratePerHourCents: 10000, riskSurchargePct: 20 });

    // Revision invalidates the open offer and requires re-confirmation and re-assessment.
    const rev = await w.call('update_feature_scope', { featureRequestId: fr.id, scope: { exceptions: [...reminderScope.exceptions, 'Keine Erinnerung unter 10 EUR'] } });
    expect(rev.result.status).toBe('drafting');
    await expect(w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true })).rejects.toMatchObject({ code: 'stale_offer' });
    await w.call('confirm_feature_scope', { featureRequestId: fr.id, scopeVersion: rev.result.scopeVersion, confirm: true });
    await w.drain();
    const fr2 = (await w.call('get_feature_request', { featureRequestId: fr.id })).result;
    expect(fr2.offers.map((o: any) => [o.version, o.status])).toEqual([[1, 'superseded'], [2, 'open']]);
    expect(w.github.issues.size).toBe(1); // ticket reused

    const acc = await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr2.currentOffer.id, offerVersion: 2, confirm: true });
    expect(acc.result.order).toMatchObject({ binding: false, offerVersion: 2 });
    await w.drain();
    const fr3 = (await w.call('get_feature_request', { featureRequestId: fr.id })).result;
    expect(fr3.status).toBe('pr_open');
    expect(w.github.prs).toHaveLength(1);
    expect(w.runner.calls[0]!.task).toContain('<scope version="3">');
  });

  it('routes to needs-human on invalid evidence and informs with the handover text', async () => {
    const w = await world();
    w.assessor.next = { ...goodAssessment, evidence: [{ path: 'src/tools/registry.ts', quote: 'this line does not exist anywhere' }] };
    const fr = await toOffer(w);
    expect(fr.status).toBe('needs_human');
    expect(fr.assessment.validationErrors).toContain('evidence_not_in_snapshot:src/tools/registry.ts');
    expect(fr.offers).toHaveLength(0);
    expect(w.github.issues.get(1)!.label).toBe('needs-human');
    const n = await w.call('get_notifications', {});
    expect(n.result.items.map((x: any) => x.message)).toContain(HANDOVER_MESSAGE);
  });

  it('routes to needs-human on blockers even if the model claims automatable', async () => {
    const w = await world();
    w.assessor.next = { ...goodAssessment, blockers: ['needs SMTP credentials'] };
    expect((await toOffer(w)).status).toBe('needs_human');
  });

  it('pauses implementation on policy violations or failing checks, never opening a PR', async () => {
    for (const next of [
      { ...okRun, files: [{ path: 'package.json', content: '{}', existedBefore: true }] },
      { ...okRun, files: [{ path: 'tests/billing.test.ts', content: '', existedBefore: true }] },
      { ...okRun, after: [{ name: 'after:test', ok: false, exitCode: 1, outputTail: 'fail' }] },
      { status: 'needs_human' as const, reason: 'coding agent timed out' },
    ]) {
      const w = await world();
      w.runner.next = next as never;
      const fr = await toOffer(w);
      await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true });
      await w.drain();
      const after = (await w.call('get_feature_request', { featureRequestId: fr.id })).result;
      expect(after.status).toBe('needs_human');
      expect(w.github.prs).toHaveLength(0);
      expect(w.store.allJobs().find((j) => j.type === 'feature.implement')!.status).toBe('paused');
    }
  });

  it('pauses when the code base changed after assessment', async () => {
    const w = await world();
    const fr = await toOffer(w);
    w.github.head = 'b'.repeat(40);
    await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true });
    await w.drain();
    expect(w.runner.calls).toHaveLength(0);
    expect(w.store.allJobs().find((j) => j.type === 'feature.implement')!.lastError).toMatch(/re-assessment/);
  });

  it('only registers known job types', () => {
    expect(Object.keys(handlers).sort()).toEqual(['feature.assess', 'feature.implement']);
  });
});

describe('notifications', () => {
  it('fetching is not acknowledging; acknowledgement is explicit', async () => {
    const w = await world();
    await toOffer(w);
    const first = await w.call('get_notifications', { limit: 2 });
    expect(first.result.items).toHaveLength(2);
    expect(first.result.hasMore).toBe(true);
    const again = await w.call('get_notifications', {});
    expect(again.result.items.length).toBeGreaterThanOrEqual(3);
    const page2 = await w.call('get_notifications', { cursor: first.result.nextCursor });
    expect(page2.result.items[0].cursor).toBeGreaterThan(first.result.nextCursor);
    await w.call('acknowledge_notifications', { cursors: first.result.items.map((i: any) => i.cursor) });
    const rest = await w.call('get_notifications', {});
    expect(rest.result.items.length).toBe(again.result.items.length - 2);
  });
});

describe('operator re-assessment', () => {
  it('supersedes the accepted offer of a paused order and requires a new acceptance', async () => {
    const { reopenForAssessment } = await import('../src/services/features.js');
    const { makeCtx } = await import('../src/tools/registry.js');
    const w = await world();
    w.runner.next = { status: 'needs_human', reason: 'runner timeout' };
    const fr = await toOffer(w);
    await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true });
    await w.drain();
    await w.store.transaction('demo-tenant', (tx) => reopenForAssessment(makeCtx(tx, 'operator', '2026-10-30'), fr.id));
    await w.drain();
    const after = (await w.call('get_feature_request', { featureRequestId: fr.id })).result;
    expect(after.status).toBe('offer_ready');
    expect(after.orderId).toBeUndefined();
    expect(after.offers.map((o: any) => [o.version, o.status])).toEqual([[1, 'superseded'], [2, 'open']]);
    await expect(w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true })).rejects.toMatchObject({ code: 'stale_offer' });
  });
});

describe('review rounds', () => {
  it('lets an operator clarify a paused run of an accepted order', async () => {
    const { requestChanges } = await import('../src/services/features.js');
    const { makeCtx } = await import('../src/tools/registry.js');
    const w = await world();
    const fr = await toOffer(w);
    w.runner.next = { status: 'needs_human', reason: 'policy: tests/sub/x.test.ts' };
    await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true });
    await w.drain();
    w.runner.next = okRun;
    await w.store.transaction('demo-tenant', (tx) => requestChanges(makeCtx(tx, 'operator', '2026-10-30'), fr.id, 'Put new tests directly into tests/, not into subfolders.'));
    await w.drain();
    expect(w.runner.calls.at(-1)!.task).toContain('<review round="1">');
    expect(w.github.prs.at(-1)!.body).toContain('Review round 1.');
    expect((await w.call('get_feature_request', { featureRequestId: fr.id })).result.status).toBe('pr_open');
  });

  it('re-runs the implementation with review notes and references the superseded PR', async () => {
    const { requestChanges } = await import('../src/services/features.js');
    const { makeCtx } = await import('../src/tools/registry.js');
    const w = await world();
    const fr = await toOffer(w);
    await w.call('accept_dev_offer', { featureRequestId: fr.id, offerId: fr.currentOffer.id, offerVersion: 1, confirm: true });
    await w.drain();
    expect(w.github.prs).toHaveLength(1);
    await expect(w.store.transaction('demo-tenant', (tx) => requestChanges(makeCtx(tx, 'operator', '2026-10-30'), 'FR-9999', 'x'.repeat(30)))).rejects.toMatchObject({ status: 404 });
    await w.store.transaction('demo-tenant', (tx) => requestChanges(makeCtx(tx, 'operator', '2026-10-30'), fr.id, 'Grammatik: "Der offene Betrag".'));
    await w.drain();
    expect(w.runner.calls.at(-1)!.task).toContain('<review round="1" pr="101">');
    expect(w.runner.calls.at(-1)!.task).toContain('Der offene Betrag');
    expect(w.github.prs).toHaveLength(2);
    expect(w.github.prs[1]!.body).toContain('supersedes #101');
    expect((await w.call('get_feature_request', { featureRequestId: fr.id })).result.status).toBe('pr_open');
    await w.store.transaction('demo-tenant', (tx) => requestChanges(makeCtx(tx, 'operator', '2026-10-30'), fr.id, 'Second round: keep tests and add more.'));
    await w.drain();
    const task = w.runner.calls.at(-1)!.task;
    expect(task).toContain('<review round="1" pr="101">');
    expect(task).toContain('Der offene Betrag');
    expect(task).toContain('<review round="2" pr="102">');
  });
});
