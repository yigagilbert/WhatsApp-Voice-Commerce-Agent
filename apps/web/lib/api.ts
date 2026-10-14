import 'server-only';
import { loadWebConfig } from '@vca/config';
import { requireUser } from './auth';

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
  await requireUser();
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
        ...init.headers,
      },
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok)
      return { ok: false, error: body?.error?.message ?? `API responded ${response.status}` };
    return { ok: true, data: body as T };
  } catch {
    return {
      ok: false,
      error: `Cannot reach the API at ${cfg.API_BASE_URL}. Is it running (pnpm dev:api)?`,
    };
  }
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
