import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { loadWebConfig } from '@vca/config';
import { BOOTSTRAP_USER_ID, SESSION_COOKIE, verifySessionToken } from '@/lib/session';

/**
 * Where the dashboard sends someone whose session the API no longer accepts (password changed,
 * account deactivated, or the setup login after accounts exist). The cookie is still validly
 * signed, so it must be cleared here — page renders can't change cookies — or every page,
 * including the sign-in page's layout, would keep bouncing back.
 *
 * It only clears a session the API really rejects, so a link from another site can't sign
 * someone out.
 */
export async function GET(request: Request) {
  const jar = await cookies();
  const user = verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (user && (await stillValid(user))) return NextResponse.redirect(new URL('/', request.url));
  jar.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login?expired=1', request.url));
}

async function stillValid(user: { id: string; version: number }): Promise<boolean> {
  const cfg = loadWebConfig();
  try {
    const res = await fetch(`${cfg.API_BASE_URL.replace(/\/$/, '')}/api/auth/me`, {
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${cfg.API_AUTH_TOKEN}`,
        ...(user.id === BOOTSTRAP_USER_ID
          ? {}
          : { 'x-dashboard-user': user.id, 'x-dashboard-session': String(user.version) }),
      },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status !== 401;
  } catch {
    // API unreachable: keep the session (the person sees the "service not responding" notice).
    return true;
  }
}
