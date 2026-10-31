import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExportFile } from '../domain/types.js';
import { AppError } from '../services/errors.js';
import * as features from '../services/features.js';
import { executeTool, makeCtx, tools, type Deps } from '../tools/registry.js';
import { authenticate, requireRole, type TokenEntry } from './auth.js';
import { buildOpenApi } from './openapi.js';

export interface ApiOptions { deps: Deps; tokens: TokenEntry[]; logger?: boolean }

const requeueBody = z.strictObject({ stage: z.enum(['assess', 'implement']), reason: z.string().min(10).max(2000) });
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
};
const reviewBody = z.strictObject({ notes: z.string().min(20).max(8000) });
const commitBody = z.strictObject({ commit: z.string().regex(/^[0-9a-f]{40}$/), prNumber: z.number().int().positive().optional() });

export function buildApi(opts: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const { deps } = opts;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_input', message: 'Ungültige Eingabe.', details: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Technischer Fehler. Das ist keine Produktlücke.' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/openapi.json', async (req) => {
    authenticate(req, opts.tokens);
    return buildOpenApi();
  });

  app.get('/v1/tools', async (req) => {
    authenticate(req, opts.tokens);
    return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, permission: t.permission }));
  });

  app.post<{ Params: { name: string } }>('/v1/tools/:name', async (req) => {
    const entry = authenticate(req, opts.tokens);
    requireRole(entry, 'service');
    return executeTool(deps, entry.principal, req.params.name, req.body);
  });

  app.get<{ Params: { id: string } }>('/v1/files/:id', async (req, reply) => {
    const entry = authenticate(req, opts.tokens);
    const file = await deps.store.transaction(entry.principal.tenantId, (tx) => tx.get<ExportFile>('export', req.params.id));
    if (!file) throw new AppError(404, 'not_found', 'Datei nicht gefunden.');
    let abs: string;
    try {
      abs = await deps.artifacts.resolveForRead(file.relPath);
    } catch {
      throw new AppError(404, 'not_found', 'Datei nicht verfügbar.');
    }
    const type = MIME[extname(file.fileName)] ?? 'application/octet-stream';
    return reply.header('content-type', type).header('content-disposition', `attachment; filename="${file.fileName}"`).send(createReadStream(abs));
  });

  // Operator endpoints: third token, never given to MCP clients.
  app.post<{ Params: { id: string } }>('/v1/operator/feature-requests/:id/requeue', async (req) => {
    const entry = authenticate(req, opts.tokens);
    requireRole(entry, 'operator');
    const body = requeueBody.parse(req.body);
    return deps.store.transaction(entry.principal.tenantId, async (tx) => {
      const ctx = makeCtx(tx, entry.principal.name, deps.today);
      const fr = await features.loadFeature(ctx, req.params.id);
      if (body.stage === 'assess') {
        await features.reopenForAssessment(ctx, fr.id);
      } else {
        if (fr.status !== 'accepted' || !fr.orderId) throw new AppError(409, 'invalid_state', `Status ${fr.status} kann nicht umgesetzt werden.`);
        await tx.enqueueJob('feature.implement', { featureRequestId: fr.id, orderId: fr.orderId });
      }
      await tx.audit(entry.principal.name, 'operator.requeue', { id: fr.id, stage: body.stage, reason: body.reason });
      return { requeued: body.stage };
    });
  });

  app.post<{ Params: { id: string } }>('/v1/operator/feature-requests/:id/request-changes', async (req) => {
    const entry = authenticate(req, opts.tokens);
    requireRole(entry, 'operator');
    const body = reviewBody.parse(req.body);
    return deps.store.transaction(entry.principal.tenantId, async (tx) => {
      const ctx = makeCtx(tx, entry.principal.name, deps.today);
      const fr = await features.loadFeature(ctx, req.params.id);
      const jobId = await features.requestChanges(ctx, fr.id, body.notes);
      await tx.audit(entry.principal.name, 'operator.changes_requested', { id: fr.id, pr: fr.pullRequest?.number });
      return { jobId };
    });
  });

  app.post<{ Params: { id: string } }>('/v1/operator/feature-requests/:id/approve-merge', async (req) => {
    const entry = authenticate(req, opts.tokens);
    requireRole(entry, 'operator');
    const body = commitBody.parse(req.body);
    return deps.store.transaction(entry.principal.tenantId, async (tx) => {
      const ctx = makeCtx(tx, entry.principal.name, deps.today);
      const fr = await features.loadFeature(ctx, req.params.id);
      if (fr.status !== 'pr_open' || !fr.pullRequest) throw new AppError(409, 'invalid_state', 'Kein offener Pull-Request.');
      await tx.audit(entry.principal.name, 'operator.merge_approved', { id: fr.id, commit: body.commit });
      return features.setFeatureStatus(ctx, fr.id, 'merged', `Review für ${fr.number} abgeschlossen; Commit ${body.commit.slice(0, 7)} freigegeben, Deployment steht aus.`, {
        pullRequest: { ...fr.pullRequest, commit: body.commit },
      });
    });
  });

  app.post<{ Params: { id: string } }>('/v1/operator/feature-requests/:id/deployed', async (req) => {
    const entry = authenticate(req, opts.tokens);
    requireRole(entry, 'operator');
    const body = commitBody.parse(req.body);
    return deps.store.transaction(entry.principal.tenantId, async (tx) => {
      const ctx = makeCtx(tx, entry.principal.name, deps.today);
      const fr = await features.loadFeature(ctx, req.params.id);
      if (fr.status !== 'merged' || fr.pullRequest?.commit !== body.commit) {
        throw new AppError(409, 'not_approved', 'Nur der freigegebene Commit darf als bereitgestellt markiert werden.');
      }
      await tx.audit(entry.principal.name, 'operator.deployed', { id: fr.id, commit: body.commit });
      return features.setFeatureStatus(ctx, fr.id, 'deployed', `${fr.title} ist lokal bereitgestellt. Bitte Werkzeugliste im Client neu laden und fachlich ausprobieren.`, {
        deployment: { commit: body.commit, deployedAt: ctx.now() },
      });
    });
  });

  return app;
}
