'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadWebConfig } from '@vca/config';
import {
  BOOTSTRAP_USER_ID,
  SESSION_COOKIE,
  checkBootstrapCredentials,
  clientIp,
  safeNextPath,
  type SessionUser,
} from '@/lib/session';
import { startSession } from '@/lib/session-cookie';

export interface LoginState {
  error?: string;
}

/**
 * Brute-force throttle per client IP (in memory): 10 failures per 15 minutes. The IP comes from the
 * header the proxy sets, so it can't be rotated by the client. Accounts are also locked by the API
 * after 5 wrong passwords, whatever the IP.
 */
const failures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

interface LoginResponse {
  user?: {
    id: string;
    username: string;
    name: string;
    role: 'OWNER' | 'STAFF';
    sessionVersion: number;
  };
  error?: { code?: string; message?: string };
}

async function apiLogin(username: string, password: string) {
  const cfg = loadWebConfig();
  const response = await fetch(`${cfg.API_BASE_URL.replace(/\/$/, '')}/api/auth/login`, {
    method: 'POST',
    cache: 'no-store',
    headers: { authorization: `Bearer ${cfg.API_AUTH_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as LoginResponse,
  };
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const h = await headers();
  const client = clientIp((name) => h.get(name), loadWebConfig().DASHBOARD_CLIENT_IP_HEADER);
  const now = Date.now();
  const recent = (failures.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_FAILURES) {
    return { error: 'Too many failed attempts. Please wait 15 minutes and try again.' };
  }
  const fail = (error: string): LoginState => {
    failures.set(client, [...recent, now]);
    if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    return { error };
  };

  const username = String(formData.get('username') ?? '').slice(0, 200);
  const password = String(formData.get('password') ?? '').slice(0, 200);
  let user: SessionUser;
  let result;
  try {
    result = await apiLogin(username, password);
  } catch {
    return { error: 'The Katale service is not responding right now. Please try again shortly.' };
  }
  if (result.status === 200 && result.body.user) {
    const u = result.body.user;
    user = {
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      version: u.sessionVersion,
    };
  } else if (result.body.error?.code === 'NO_ACCOUNTS') {
    // First-time setup: the shared login from the environment, until an owner account exists.
    const check = checkBootstrapCredentials(username, password);
    if (check === 'not_configured')
      return { error: 'Dashboard login is not configured (DASHBOARD_PASSWORD is not set).' };
    if (check === 'invalid') return fail('Incorrect username or password.');
    user = { id: BOOTSTRAP_USER_ID, username, name: 'Setup login', role: 'OWNER', version: 0 };
  } else if (result.status === 401) {
    return fail(result.body.error?.message ?? 'Incorrect username or password.');
  } else {
    return { error: 'Sign-in is unavailable right now. Please try again shortly.' };
  }

  failures.delete(client);
  await startSession(user);
  redirect(user.id === BOOTSTRAP_USER_ID ? '/account' : safeNextPath(formData.get('next')));
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
