import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './lib/session';
import {
  CURRENT_PATH_HEADER,
  SESSION_ENDED_MESSAGE,
  loginAfterSessionEnded,
  pagePath,
} from './lib/session-ended';

/**
 * The public website: the homepage, the stable WhatsApp link (/chat), the login page and merchant
 * storefronts (/shop/...). They show only published information. Anything else is the dashboard.
 */
const PUBLIC_PATHS = new Set([
  '/',
  '/chat',
  '/login',
  // Only clears a session the API rejects, then goes to sign-in. Next can request it twice, and by
  // the second time the cookie is gone: gating it would send people to sign in with no explanation.
  '/session-ended',
  '/robots.txt',
  '/sitemap.xml',
]);

/**
 * Dashboard gate: everything except the public pages and static assets requires a valid session.
 * PayPal callbacks are API routes served by the API container, not by this app, so they are never
 * affected. Server Actions are POSTs to page routes and are covered too (and re-checked in code).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname === '/shop' || pathname.startsWith('/shop/'))
    return NextResponse.next();

  const path = pagePath(pathname, search);
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    const headers = new Headers(request.headers);
    headers.set(CURRENT_PATH_HEADER, path);
    return NextResponse.next({ request: { headers } });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Still refused here, before the action runs. Next's client follows x-action-redirect, so a
    // save or a console message goes to sign-in rather than failing; if that header ever stops
    // being honoured, this exact plain-text body reaches (dashboard)/error.tsx, which does the same.
    return new NextResponse(SESSION_ENDED_MESSAGE, {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        ...(request.headers.has('next-action')
          ? { 'x-action-redirect': `${loginAfterSessionEnded(path)};replace` }
          : {}),
      },
    });
  }
  // Someone already in the dashboard (a stale cookie, or a click from a page they had open) is told
  // why they are back at sign-in; a first visit isn't.
  const wasSignedIn = request.cookies.has(SESSION_COOKIE) || request.headers.has('rsc');
  if (wasSignedIn) return NextResponse.redirect(new URL(loginAfterSessionEnded(path), request.url));
  const login = new URL('/login', request.url);
  login.searchParams.set('next', path);
  return NextResponse.redirect(login);
}

export const config = {
  // Tab icons and the social preview image are public assets.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|opengraph-image|twitter-image).*)',
  ],
};
