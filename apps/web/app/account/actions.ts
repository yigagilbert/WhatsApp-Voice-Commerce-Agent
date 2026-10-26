'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiPatch, apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { BOOTSTRAP_USER_ID, SESSION_COOKIE } from '@/lib/session';
import { startSession } from '@/lib/session-cookie';

export type AccountState = { ok: boolean; message: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** Changes the signed-in person's password; their other sessions end, this one continues. */
export async function changePassword(_prev: AccountState, form: FormData): Promise<AccountState> {
  const user = await requireUser();
  if (text(form, 'next') !== text(form, 'confirm'))
    return { ok: false, message: 'The new passwords do not match.' };
  const result = await apiPost<{ sessionVersion: number }>('/api/auth/password', {
    current: text(form, 'current'),
    next: text(form, 'next'),
  });
  if (!result.ok) return { ok: false, message: result.error };
  await startSession({ ...user, version: result.data.sessionVersion });
  return { ok: true, message: 'Password changed. Other devices have been signed out.' };
}

/** Owners: creates a dashboard account. From the setup login, this is the first owner. */
export async function createAccount(_prev: AccountState, form: FormData): Promise<AccountState> {
  const user = await requireUser();
  if (text(form, 'password') !== text(form, 'confirm'))
    return { ok: false, message: 'The passwords do not match.' };
  const result = await apiPost('/api/dashboard-users', {
    username: text(form, 'username'),
    name: text(form, 'name'),
    role:
      user.id === BOOTSTRAP_USER_ID ? 'OWNER' : text(form, 'role') === 'OWNER' ? 'OWNER' : 'STAFF',
    password: text(form, 'password'),
  });
  if (!result.ok) return { ok: false, message: result.error };
  revalidatePath('/account');
  // The setup login stops working once an account exists: sign in with the new one.
  if (user.id === BOOTSTRAP_USER_ID) {
    (await cookies()).delete(SESSION_COOKIE);
    redirect('/login?created=1');
  }
  return { ok: true, message: 'Account created. Share the password with them privately.' };
}

/** Owners: activate/deactivate, change role or set a new password (ends that person's sessions). */
export async function updateAccount(
  id: string,
  change: { active?: boolean; role?: 'OWNER' | 'STAFF'; password?: string },
): Promise<AccountState> {
  await requireUser();
  const result = await apiPatch(`/api/dashboard-users/${encodeURIComponent(id)}`, change);
  revalidatePath('/account');
  return result.ok
    ? { ok: true, message: 'Saved. That person must sign in again.' }
    : { ok: false, message: result.error };
}
