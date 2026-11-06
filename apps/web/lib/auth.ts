import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifySessionToken, type SessionUser } from './session';
import { CURRENT_PATH_HEADER, loginAfterSessionEnded } from './session-ended';

/** Current dashboard user, or null. For layouts that render differently when signed out. */
export async function currentUser(): Promise<SessionUser | null> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Defence in depth: every server-side data access and server action calls this, so routes stay
 * protected even if the proxy matcher changes. (The API also re-validates the account itself.)
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const path = (await headers()).get(CURRENT_PATH_HEADER);
    redirect(path ? loginAfterSessionEnded(path) : '/login');
  }
  return user;
}
