import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, createSessionToken, type SessionUser } from './session';

/**
 * Issues the session cookie. Deliberately NOT in a 'use server' file: every export of such a file
 * is a public server action, and this must only ever run after a verified sign-in.
 */
export async function startSession(user: SessionUser): Promise<void> {
  const { token, maxAgeSeconds } = createSessionToken(user);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}
