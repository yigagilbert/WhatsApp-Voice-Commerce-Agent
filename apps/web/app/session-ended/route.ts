import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

/**
 * Where the dashboard sends someone whose session the API no longer accepts (password changed,
 * account deactivated, or the setup login after accounts exist). The cookie is still validly
 * signed, so it must be cleared here — page renders can't change cookies — or every page,
 * including the sign-in page's layout, would keep bouncing back.
 */
export async function GET(request: Request) {
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login?expired=1', request.url));
}
