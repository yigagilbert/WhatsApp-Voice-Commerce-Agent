'use server';

import { revalidatePath } from 'next/cache';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type ActionState = { ok: boolean; message: string } | null;

const flag = (form: FormData, name: string) => form.get(name) === 'on';

export async function addAdmin(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const result = await apiPost('/api/admins', {
    name: String(form.get('name') ?? ''),
    phone: String(form.get('phone') ?? ''),
    receiveReports: flag(form, 'receiveReports'),
    receiveAlerts: flag(form, 'receiveAlerts'),
    role: form.get('role') === 'OWNER' ? 'OWNER' : 'STAFF',
  });
  revalidatePath('/admins');
  return result.ok ? { ok: true, message: 'Admin added.' } : { ok: false, message: result.error };
}

export async function updateAdmin(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const id = String(form.get('id'));
  const result = await apiPatch(`/api/admins/${encodeURIComponent(id)}`, {
    name: String(form.get('name') ?? ''),
    phone: String(form.get('phone') ?? ''),
    receiveReports: flag(form, 'receiveReports'),
    receiveAlerts: flag(form, 'receiveAlerts'),
    role: form.get('role') === 'OWNER' ? 'OWNER' : 'STAFF',
  });
  revalidatePath('/admins');
  return result.ok ? { ok: true, message: 'Saved.' } : { ok: false, message: result.error };
}

export async function setAdminActive(id: string, active: boolean): Promise<ActionState> {
  await requireUser();
  const result = await apiPatch(`/api/admins/${encodeURIComponent(id)}`, { active });
  revalidatePath('/admins');
  return result.ok
    ? { ok: true, message: active ? 'Activated.' : 'Deactivated.' }
    : { ok: false, message: result.error };
}

export async function removeAdmin(id: string): Promise<ActionState> {
  await requireUser();
  const result = await apiDelete(`/api/admins/${encodeURIComponent(id)}`);
  revalidatePath('/admins');
  return result.ok ? { ok: true, message: 'Removed.' } : { ok: false, message: result.error };
}

export async function testAdmin(id: string): Promise<ActionState> {
  await requireUser();
  const result = await apiPost(`/api/admins/${encodeURIComponent(id)}/test`, {});
  return result.ok
    ? { ok: true, message: 'Test message sent.' }
    : { ok: false, message: result.error };
}
