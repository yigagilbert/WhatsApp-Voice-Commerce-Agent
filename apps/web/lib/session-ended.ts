/**
 * What happens when a dashboard session ends while someone is working. Free of server imports:
 * proxy.ts, server code and client components all use these.
 */

/** Body of the proxy's 401 to a Server Action. The dashboard error boundary recognises it. */
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';

/** Set by proxy.ts for signed-in requests, so server code knows which page to come back to. */
export const CURRENT_PATH_HEADER = 'x-katale-path';

/** The page a request belongs to: a Server Action posts to the page's own URL. */
export const pagePath = (pathname: string, search: string): string => {
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
};

export const loginAfterSessionEnded = (path: string): string =>
  `/login?expired=1&next=${encodeURIComponent(path)}`;

const SESSION_REDIRECT = /^NEXT_REDIRECT;[^;]*;\/(?:login\?expired=1|session-ended)/;

/** True for the error a Server Action call rejects with once the session is gone. */
export const isSessionEndedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.message === SESSION_ENDED_MESSAGE) return true;
  const digest = (error as Error & { digest?: unknown }).digest;
  return typeof digest === 'string' && SESSION_REDIRECT.test(digest);
};

/** Next.js redirects travel as errors: anything catching an action's failure must rethrow them. */
export const isRedirectError = (error: unknown): boolean => {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;');
};
