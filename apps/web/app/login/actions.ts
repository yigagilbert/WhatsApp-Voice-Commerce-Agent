'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, checkCredentials, createSessionToken, safeNextPath } from '@/lib/session';

export interface LoginState {
  error?: string;
}

/** Simple in-memory brute-force throttle: 5 failures per client per 15 minutes. */
const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function clientKey(forwardedFor: string | null): string {
  return forwardedFor?.split(',')[0]?.trim() || 'unknown';
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const client = clientKey((await headers()).get('x-forwarded-for'));
  const now = Date.now();
  const recent = (failures.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_FAILURES) {
    return { error: 'Too many failed attempts. Please wait 15 minutes and try again.' };
  }

  const username = String(formData.get('username') ?? '').slice(0, 200);
  const password = String(formData.get('password') ?? '').slice(0, 200);
  const result = checkCredentials(username, password);
  if (result === 'not_configured') {
    return { error: 'Dashboard login is not configured (DASHBOARD_PASSWORD is not set).' };
  }
  if (result === 'invalid') {
    failures.set(client, [...recent, now]);
    return { error: 'Incorrect username or password.' };
  }

  failures.delete(client);
  const { token, maxAgeSeconds } = createSessionToken(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  redirect(safeNextPath(formData.get('next')));
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
