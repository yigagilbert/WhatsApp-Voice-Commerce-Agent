import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadWebConfig } from '@vca/config';

/**
 * Dashboard session: an HMAC-signed cookie `<base64url(payload)>.<signature>` naming the signed-in
 * account. The signing key is derived from the server-only API_AUTH_TOKEN, so rotating that token
 * invalidates every session. The signature only proves the cookie is ours; the API re-checks on
 * every request that the account is still active and the session version is current (changing a
 * password or deactivating an account ends its sessions). Used by proxy.ts and server code.
 */
export const SESSION_COOKIE = 'katale_session';

/** The bootstrap ("setup") login, valid only while no dashboard account exists. */
export const BOOTSTRAP_USER_ID = 'bootstrap';

export interface SessionUser {
  /** DashboardUser ID, or "bootstrap". */
  id: string;
  username: string;
  name: string;
  role: 'OWNER' | 'STAFF';
  /** Session version of the account when signed in (0 for bootstrap). */
  version: number;
}

interface SessionPayload {
  u: string;
  n: string;
  d: string;
  r: 'OWNER' | 'STAFF';
  v: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

const key = () =>
  createHash('sha256')
    .update(`katale-dashboard-session:${loadWebConfig().API_AUTH_TOKEN}`)
    .digest();

const sign = (data: string) => createHmac('sha256', key()).update(data).digest('base64url');

export function createSessionToken(
  user: SessionUser,
  now = Date.now(),
): { token: string; maxAgeSeconds: number } {
  const maxAgeSeconds = Math.round(loadWebConfig().DASHBOARD_SESSION_HOURS * 3600);
  const payload: SessionPayload = {
    u: user.id,
    n: user.username,
    d: user.name,
    r: user.role,
    v: user.version,
    exp: Math.floor(now / 1000) + maxAgeSeconds,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${data}.${sign(data)}`, maxAgeSeconds };
}

/** Returns the session's account for a valid, unexpired token; null otherwise. Never throws. */
export function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): SessionUser | null {
  if (!token) return null;
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  try {
    const expected = Buffer.from(sign(data));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const p = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf8'),
    ) as Partial<SessionPayload>;
    if (
      typeof p.u !== 'string' ||
      typeof p.n !== 'string' ||
      typeof p.exp !== 'number' ||
      typeof p.v !== 'number' ||
      (p.r !== 'OWNER' && p.r !== 'STAFF')
    )
      return null;
    if (p.exp * 1000 <= now) return null;
    // The setup login is tied to the configured username (changing it ends those sessions).
    if (p.u === BOOTSTRAP_USER_ID && p.n !== loadWebConfig().DASHBOARD_USERNAME) return null;
    return {
      id: p.u,
      username: p.n,
      name: typeof p.d === 'string' ? p.d : p.n,
      role: p.r,
      version: p.v,
    };
  } catch {
    return null;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time check of the bootstrap (setup) credentials from the environment. */
export function checkBootstrapCredentials(
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
    !next.startsWith('/\\') &&
    !next.startsWith('/login')
    ? next
    : '/';
}

/**
 * The client IP for the login throttle: only the header the reverse proxy sets (X-Real-IP by
 * default), else the LAST X-Forwarded-For hop (appended by the proxy, not the client).
 */
export function clientIp(get: (name: string) => string | null, header: string): string {
  const direct = get(header)?.trim();
  if (direct) return direct;
  const forwarded = get('x-forwarded-for')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded?.at(-1) ?? 'unknown';
}
