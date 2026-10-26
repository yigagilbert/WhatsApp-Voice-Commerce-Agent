import 'server-only';
import { loadWebConfig } from '@vca/config';
import { redirect } from 'next/navigation';
import { requireUser } from './auth';
import { BOOTSTRAP_USER_ID } from './session';

/**
 * Server-side API access. The dashboard token lives only on the server — it is never
 * sent to the browser. Pages are rendered dynamically so data is always current.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

function config() {
  return loadWebConfig();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  // Every dashboard data access requires a signed-in user (redirects to /login otherwise).
  const user = await requireUser();
  let cfg;
  try {
    cfg = config();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid configuration' };
  }
  try {
    const response = await fetch(`${cfg.API_BASE_URL.replace(/\/$/, '')}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${cfg.API_AUTH_TOKEN}`,
        'content-type': 'application/json',
        // Who is asking: the API checks the account is active and the session still current.
        ...(user.id === BOOTSTRAP_USER_ID
          ? {}
          : { 'x-dashboard-user': user.id, 'x-dashboard-session': String(user.version) }),
        ...init.headers,
      },
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    // 401 = the session ended (password changed, account deactivated, or the setup login after
    // accounts exist): handled below by sending the person to sign in again.
    if (response.status !== 401) {
      if (!response.ok)
        return { ok: false, error: body?.error?.message ?? `API responded ${response.status}` };
      return { ok: true, data: body as T };
    }
  } catch {
    return {
      ok: false,
      error: 'The Katale service is not responding right now. Please try again in a moment.',
    };
  }
  // Outside the try: redirect() works by throwing. /session-ended clears the cookie first.
  redirect('/session-ended');
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
// A JSON content-type needs a body for Fastify, so DELETE sends {}.
export const apiDelete = (path: string) => request<unknown>(path, { method: 'DELETE', body: '{}' });
