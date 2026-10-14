import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HEADERS, UnauthorizedError } from '@vca/shared';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time string comparison (hashing first equalises lengths). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const bearer = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
};

const internal = (request: FastifyRequest): string | undefined => {
  const value = request.headers[HEADERS.internalToken];
  return Array.isArray(value) ? value[0] : value;
};

export type Caller = 'dashboard' | 'internal';

/**
 * Hackathon-grade service authentication:
 * - the dashboard (server-side only) presents `Authorization: Bearer API_AUTH_TOKEN`
 * - channel workers present `x-internal-token: INTERNAL_SERVICE_TOKEN`
 * Real merchant user authentication is on the roadmap.
 */
export function authenticate(
  request: FastifyRequest,
  tokens: { dashboard: string; internal: string },
  allowed: Caller[],
): Caller {
  const b = bearer(request);
  if (b && allowed.includes('dashboard') && safeEqual(b, tokens.dashboard)) return 'dashboard';
  const i = internal(request);
  if (i && allowed.includes('internal') && safeEqual(i, tokens.internal)) return 'internal';
  throw new UnauthorizedError();
}
