import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../services/errors.js';
import type { Principal } from '../tools/registry.js';

export type Role = 'service' | 'operator';
export interface TokenEntry { token: string; role: Role; principal: Principal }

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function authenticate(req: FastifyRequest, entries: TokenEntry[]): TokenEntry {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  const entry = match ? entries.find((e) => safeEqual(e.token, match[1]!)) : undefined;
  if (!entry) throw new AppError(401, 'unauthorized', 'Fehlendes oder ungültiges Token.');
  return entry;
}

export function requireRole(entry: TokenEntry, role: Role) {
  if (entry.role !== role) throw new AppError(403, 'forbidden', `Rolle ${role} erforderlich.`);
}
