import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './lib/session';

/**
 * The public website: the homepage, the stable WhatsApp link (/chat), the login page and merchant
 * storefronts (/shop/...). They show only published information. Anything else is the dashboard.
 */
const PUBLIC_PATHS = new Set(['/', '/chat', '/login', '/robots.txt', '/sitemap.xml']);

/**
 * Dashboard gate: everything except the public pages and static assets requires a valid session.
 * PayPal callbacks are API routes served by the API container, not by this app, so they are never
 * affected. Server Actions are POSTs to page routes and are covered too (and re-checked in code).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname === '/shop' || pathname.startsWith('/shop/'))
    return NextResponse.next();

  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new NextResponse('Authentication required', { status: 401 });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Tab icons and the social preview image are public assets.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|opengraph-image|twitter-image).*)',
  ],
};
