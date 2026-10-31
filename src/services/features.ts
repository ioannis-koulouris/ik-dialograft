import type { Assessment, DevOffer, FeatureRequest, Order, Scope } from '../domain/types.js';
import { type Ctx, nextNumber } from './context.js';
import { conflict, invalid, notFound } from './errors.js';
import { type PricingConfig, priceRange } from './pricing.js';

export const HANDOVER_MESSAGE =
  'Deine Anfrage ist aufgenommen und zur weiteren Prüfung vorgemerkt. Für die Umsetzung benötigen wir noch Unterstützung durch unser Team.';

const emptyScope = (): Scope => ({
  goal: '', trigger: '', affectedData: [], behavior: [], exceptions: [], assumptions: [], openQuestions: [], acceptanceCriteria: [], decisions: [],
});

const LOCKED: FeatureRequest['status'][] = ['accepted', 'implementing', 'pr_open', 'merged', 'deployed'];

/** Fields that change behaviour, effort or feasibility and therefore must be clarified before confirmation. */
export function missingScope(scope: Scope): string[] {
  const missing: string[] = [];
  if (!scope.goal.trim()) missing.push('goal');
  if (!scope.trigger.trim()) missing.push('trigger');
  if (scope.behavior.length === 0) missing.push('behavior');
  if (scope.acceptanceCriteria.length === 0) missing.push('acceptanceCriteria');
  for (const d of scope.decisions) if (d.status === 'proposed') missing.push(`decision:${d.topic}`);
  return missing;
}

function view(fr: FeatureRequest) {
  const missing = missingScope(fr.scope);
  const currentOffer = fr.offers.find((o) => o.status === 'open' || o.status === 'accepted');
  return { ...fr, missing, readyToConfirm: fr.status === 'drafting' && missing.length === 0, currentOffer };
}

function log(fr: FeatureRequest, ctx: Ctx, event: string) {
  fr.history.push({ at: ctx.now(), event });
}

export async function loadFeature(ctx: Ctx, ref: string): Promise<FeatureRequest> {
  const fr = (await ctx.tx.get<FeatureRequest>('feature_request', ref))
    ?? (await ctx.tx.list<FeatureRequest>('feature_request')).find((f) => f.number.toLowerCase() === ref.toLowerCase());
  if (!fr) throw notFound('Erweiterungsanfrage', ref);
  return fr;
}

export async function getFeatureRequest(ctx: Ctx, ref: string) {
  return view(await loadFeature(ctx, ref));
}

export async function listFeatureRequests(ctx: Ctx) {
  return (await ctx.tx.list<FeatureRequest>('feature_request')).map((f) => ({ id: f.id, number: f.number, title: f.title, status: f.status }));
}

type ScopePatch = Partial<Omit<Scope, 'decisions'>> & { decisions?: Scope['decisions'] };

function applyPatch(scope: Scope, patch: ScopePatch): Scope {
  const next: Scope = { ...scope };
  for (const key of ['goal', 'trigger'] as const) if (patch[key] !== undefined) next[key] = patch[key]!;
  for (const key of ['affectedData', 'behavior', 'exceptions', 'assumptions', 'openQuestions', 'acceptanceCriteria'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key]!;
  }
  if (patch.decisions) {
    const byTopic = new Map(scope.decisions.map((d) => [d.topic, d]));
    for (const d of patch.decisions) byTopic.set(d.topic, d);
    next.decisions = [...byTopic.values()];
    // Unknown answers stay visible as open questions.
    for (const d of patch.decisions) {
      if (d.status === 'unknown' && !next.openQuestions.includes(d.topic)) next.openQuestions = [...next.openQuestions, d.topic];
    }
  }
  return next;
}

export async function draftFeatureRequest(ctx: Ctx, input: { title: string; request: string; scope?: ScopePatch }) {
  const existing = (await ctx.tx.list<FeatureRequest>('feature_request')).find(
    (f) => f.title.toLowerCase() === input.title.toLowerCase() && f.status !== 'deployed',
  );
  if (existing) return { ...view(existing), reused: true };
  const fr: FeatureRequest = {
    id: ctx.newId(), number: await nextNumber(ctx, 'FR'), title: input.title, originalRequest: input.request,
    status: 'drafting', scope: applyPatch(emptyScope(), input.scope ?? {}), scopeVersion: 1, offers: [], history: [], createdAt: ctx.now(),
  };
  log(fr, ctx, 'drafted');
  await ctx.tx.put('feature_request', fr);
  await ctx.tx.audit(ctx.actor, 'feature.drafted', { id: fr.id });
  return { ...view(fr), reused: false };
}

/**
 * Updates the scope. Before acceptance any change after confirmation is a revision:
 * open offers become invalid and the new scope version must be confirmed and assessed again.
 */
export async function updateFeatureScope(ctx: Ctx, input: { featureRequestId: string; scope: ScopePatch }) {
  const fr = await loadFeature(ctx, input.featureRequestId);
  if (LOCKED.includes(fr.status)) throw conflict('scope_locked', 'Der Umfang ist bereits beauftragt und kann nicht mehr geändert werden.');
  const revised = fr.status !== 'drafting';
  fr.scope = applyPatch(fr.scope, input.scope);
  fr.scopeVersion += 1;
  if (revised) {
    for (const o of fr.offers) if (o.status === 'open') o.status = 'superseded';
    fr.status = 'drafting';
    log(fr, ctx, `revised to scope v${fr.scopeVersion}; open offers superseded`);
    await ctx.tx.notify('feature.revision', `Umfang von ${fr.number} geändert. Bisherige Angebote sind ungültig; bitte neuen Umfang bestätigen.`, { featureRequestId: fr.id });
  } else {
    log(fr, ctx, `scope v${fr.scopeVersion}`);
  }
  await ctx.tx.put('feature_request', fr);
  return view(fr);
}

export async function confirmFeatureScope(ctx: Ctx, input: { featureRequestId: string; scopeVersion: number }) {
  const fr = await loadFeature(ctx, input.featureRequestId);
  if (fr.status !== 'drafting') throw conflict('invalid_state', `Anfrage ${fr.number} ist im Status ${fr.status}.`);
  if (input.scopeVersion !== fr.scopeVersion) {
    throw conflict('stale_scope', `Bestätigt wurde Version ${input.scopeVersion}, aktuell ist ${fr.scopeVersion}.`, { scopeVersion: fr.scopeVersion });
  }
  const missing = missingScope(fr.scope);
  if (missing.length) throw invalid('Umfang ist noch unvollständig.', { missing });
  fr.confirmedScopeVersion = fr.scopeVersion;
  fr.status = 'scope_confirmed';
  log(fr, ctx, `scope v${fr.scopeVersion} confirmed`);
  await ctx.tx.put('feature_request', fr);
  const jobId = await ctx.tx.enqueueJob('feature.assess', { featureRequestId: fr.id, scopeVersion: fr.scopeVersion });
  await ctx.tx.notify('feature.scope_confirmed', `Umfang von ${fr.number} bestätigt. Ticket und Bewertung sind eingereiht.`, { featureRequestId: fr.id, jobId });
  await ctx.tx.audit(ctx.actor, 'feature.scope_confirmed', { id: fr.id, scopeVersion: fr.scopeVersion });
  return view(fr);
}

export interface EvidenceCheck { (path: string, quote: string): boolean }

/** Validates a model-produced assessment against the pinned snapshot and routes the request. Called by the worker. */
export function validateAssessment(raw: Omit<Assessment, 'route' | 'validationErrors' | 'createdAt'>, check: EvidenceCheck, contextComplete: boolean) {
  const errors: string[] = [];
  if (!contextComplete) errors.push('incomplete_context');
  if (raw.evidence.length === 0) errors.push('no_evidence');
  for (const e of raw.evidence) if (!check(e.path, e.quote)) errors.push(`evidence_not_in_snapshot:${e.path}`);
  if (raw.workPackages.length === 0) errors.push('no_work_packages');
  for (const p of raw.workPackages) if (p.minHours <= 0 || p.maxHours < p.minHours || p.maxHours > 80) errors.push(`bad_estimate:${p.title}`);
  const auto = raw.feasible && raw.automatable && raw.blockers.length === 0 && errors.length === 0;
  return { route: auto ? ('auto-implement' as const) : ('needs-human' as const), errors };
}

export async function applyAssessment(
  ctx: Ctx,
  input: { featureRequestId: string; assessment: Assessment; ticket: FeatureRequest['ticket'] },
  pricing: PricingConfig,
) {
  const fr = await loadFeature(ctx, input.featureRequestId);
  if (fr.status !== 'scope_confirmed' && fr.status !== 'assessing') return { skipped: 'state_changed' as const };
  if (fr.confirmedScopeVersion !== input.assessment.scopeVersion) return { skipped: 'stale_scope' as const };
  fr.assessment = input.assessment;
  fr.ticket = input.ticket;
  if (input.assessment.route === 'needs-human') {
    fr.status = 'needs_human';
    log(fr, ctx, 'routed needs-human');
    await ctx.tx.notify('feature.needs_human', HANDOVER_MESSAGE, { featureRequestId: fr.id, ticket: fr.ticket?.url });
  } else {
    const range = priceRange(input.assessment.workPackages, pricing);
    const version = fr.offers.length + 1;
    const offer: DevOffer = {
      id: ctx.newId(), version, scopeVersion: input.assessment.scopeVersion, assessmentCommit: input.assessment.commit,
      ratePerHourCents: pricing.ratePerHourCents, riskSurchargePct: pricing.riskSurchargePct,
      workPackages: input.assessment.workPackages, lowCents: range.lowCents, highCents: range.highCents,
      runningCosts: 'Laufende Kosten nicht bewertet (lokaler Demo-Betrieb).', status: 'open', createdAt: ctx.now(),
    };
    fr.offers.push(offer);
    fr.status = 'offer_ready';
    log(fr, ctx, `offer v${version} ready`);
    await ctx.tx.notify(
      'feature.offer_ready',
      `Unverbindliches Entwicklungsangebot v${version} für ${fr.number}: ${(range.lowCents / 100).toFixed(2)}–${(range.highCents / 100).toFixed(2)} EUR (${range.minHours}–${range.maxHours} h à ${pricing.ratePerHourCents / 100} EUR, +${pricing.riskSurchargePct} % Risiko auf Obergrenze).`,
      { featureRequestId: fr.id, offerId: offer.id, offerVersion: version },
    );
  }
  await ctx.tx.put('feature_request', fr);
  return { route: input.assessment.route };
}

export async function acceptDevOffer(ctx: Ctx, input: { featureRequestId: string; offerId: string; offerVersion: number }) {
  const fr = await loadFeature(ctx, input.featureRequestId);
  const offer = fr.offers.find((o) => o.id === input.offerId);
  if (!offer) throw notFound('Entwicklungsangebot', input.offerId);
  if (offer.status !== 'open' || offer.version !== input.offerVersion || fr.status !== 'offer_ready') {
    throw conflict('stale_offer', 'Dieses Angebot ist nicht mehr gültig.', { currentOffer: fr.offers.find((o) => o.status === 'open')?.id });
  }
  if (offer.scopeVersion !== fr.confirmedScopeVersion || offer.scopeVersion !== fr.scopeVersion) {
    throw conflict('stale_offer', 'Das Angebot gehört zu einer älteren Umfangsversion.');
  }
  offer.status = 'accepted';
  const order: Order = {
    id: ctx.newId(), number: await nextNumber(ctx, 'AU'), featureRequestId: fr.id, offerId: offer.id,
    offerVersion: offer.version, scopeVersion: offer.scopeVersion, binding: false, createdAt: ctx.now(),
  };
  fr.orderId = order.id;
  fr.status = 'accepted';
  log(fr, ctx, `offer v${offer.version} accepted; order ${order.number}`);
  await ctx.tx.put('order', order);
  await ctx.tx.put('feature_request', fr);
  const jobId = await ctx.tx.enqueueJob('feature.implement', { featureRequestId: fr.id, orderId: order.id });
  await ctx.tx.notify('feature.order_created', `Demo-Auftrag ${order.number} erstellt. Die Umsetzung ist eingereiht.`, { featureRequestId: fr.id, orderId: order.id, jobId });
  await ctx.tx.audit(ctx.actor, 'feature.offer_accepted', { id: fr.id, offerId: offer.id });
  return { order, featureRequest: view(fr) };
}

/**
 * Operator re-assessment after a documented clarification. Earlier offers (including one whose
 * order was paused) become superseded; a new offer must be accepted again.
 */
export async function reopenForAssessment(ctx: Ctx, featureRequestId: string) {
  const fr = await loadFeature(ctx, featureRequestId);
  if (fr.status !== 'needs_human') throw conflict('invalid_state', `Status ${fr.status} kann nicht neu bewertet werden.`);
  for (const o of fr.offers) if (o.status === 'open' || o.status === 'accepted') o.status = 'superseded';
  delete fr.orderId;
  fr.status = 'scope_confirmed';
  log(fr, ctx, 'reopened for assessment; previous offers superseded');
  await ctx.tx.put('feature_request', fr);
  await ctx.tx.notify('feature.reassessment', `${fr.number} wird nach Klärung erneut bewertet. Frühere Angebote sind ungültig.`, { featureRequestId: fr.id });
  return ctx.tx.enqueueJob('feature.assess', { featureRequestId: fr.id, scopeVersion: fr.confirmedScopeVersion });
}

/**
 * Human review asked for changes on the open pull request. The order stays valid; the
 * implementation runs again with the review notes and supersedes the previous pull request.
 */
export async function requestChanges(ctx: Ctx, featureRequestId: string, notes: string) {
  const fr = await loadFeature(ctx, featureRequestId);
  // Either a reviewer rejected the open PR, or an operator clarified why an accepted order's run paused.
  const pausedOrder = fr.status === 'needs_human' && fr.offers.some((o) => o.status === 'accepted');
  if (!fr.orderId || !((fr.status === 'pr_open' && fr.pullRequest) || pausedOrder)) {
    throw conflict('invalid_state', `Status ${fr.status}: kein offener Pull-Request und kein pausierter Auftrag.`);
  }
  const pr = fr.status === 'pr_open' ? fr.pullRequest!.number : 0;
  fr.reviews = [...(fr.reviews ?? []), { pr, notes, at: ctx.now() }];
  fr.status = 'accepted';
  log(fr, ctx, pr ? `changes requested on PR #${pr}` : 'operator clarified paused run; implementation requeued');
  await ctx.tx.put('feature_request', fr);
  await ctx.tx.notify('feature.changes_requested', `Review für ${fr.number}: Änderungen angefordert. Eine neue Umsetzungsrunde ist eingereiht.`, { featureRequestId: fr.id });
  return ctx.tx.enqueueJob('feature.implement', { featureRequestId: fr.id, orderId: fr.orderId });
}

/** Worker-side state transitions. */
export async function setFeatureStatus(
  ctx: Ctx, featureRequestId: string, status: FeatureRequest['status'], message: string,
  patch: Partial<Pick<FeatureRequest, 'pullRequest' | 'ticket' | 'deployment'>> = {},
) {
  const fr = await loadFeature(ctx, featureRequestId);
  Object.assign(fr, patch);
  fr.status = status;
  log(fr, ctx, status);
  await ctx.tx.put('feature_request', fr);
  await ctx.tx.notify(`feature.${status}`, message, { featureRequestId: fr.id });
  return fr;
}
