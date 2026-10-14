import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './lib/session';

/**
 * Dashboard gate: everything except the login page and static assets requires a valid session.
 * PayPal callbacks are API routes served by the API container, not by this app, so they are never
 * affected. Server Actions are POSTs to page routes and are covered too (and re-checked in code).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/login') return NextResponse.next();

  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new NextResponse('Authentication required', { status: 401 });
  }
  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
