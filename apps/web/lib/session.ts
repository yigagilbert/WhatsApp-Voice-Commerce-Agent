import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadWebConfig } from '@vca/config';

/**
 * Minimal dashboard session: an HMAC-signed cookie `<base64url(payload)>.<signature>`.
 * The signing key is derived from the server-only API_AUTH_TOKEN, so no extra secret is needed
 * and rotating that token invalidates every session. Used by proxy.ts and server code.
 */
export const SESSION_COOKIE = 'katale_session';

interface SessionPayload {
  u: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

const key = () =>
  createHash('sha256')
    .update(`katale-dashboard-session:${loadWebConfig().API_AUTH_TOKEN}`)
    .digest();

const sign = (data: string) => createHmac('sha256', key()).update(data).digest('base64url');

export function createSessionToken(
  username: string,
  now = Date.now(),
): { token: string; maxAgeSeconds: number } {
  const maxAgeSeconds = Math.round(loadWebConfig().DASHBOARD_SESSION_HOURS * 3600);
  const payload: SessionPayload = { u: username, exp: Math.floor(now / 1000) + maxAgeSeconds };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${data}.${sign(data)}`, maxAgeSeconds };
}

/** Returns the username for a valid, unexpired token; null otherwise. Never throws. */
export function verifySessionToken(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  try {
    const expected = Buffer.from(sign(data));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 <= now) return null;
    // The configured username may have changed since the session was issued.
    return payload.u === loadWebConfig().DASHBOARD_USERNAME ? payload.u : null;
  } catch {
    return null;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time credential check against the configured dashboard account. */
export function checkCredentials(
  username: string,
  password: string,
): 'ok' | 'invalid' | 'not_configured' {
  const config = loadWebConfig();
  if (!config.DASHBOARD_PASSWORD) return 'not_configured';
  const userOk = timingSafeEqual(digest(username), digest(config.DASHBOARD_USERNAME));
  const passOk = timingSafeEqual(digest(password), digest(config.DASHBOARD_PASSWORD));
  return userOk && passOk ? 'ok' : 'invalid';
}

/** Only same-site relative paths are allowed as post-login redirects (no open redirects). */
export function safeNextPath(next: unknown): string {
  return typeof next === 'string' &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.startsWith('/login')
    ? next
    : '/';
}
