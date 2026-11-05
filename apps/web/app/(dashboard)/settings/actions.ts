'use server';

import { revalidatePath } from 'next/cache';
import { apiDelete, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type KeyActionState = { ok: boolean; message: string } | null;

const path = (name: string) => `/api/settings/keys/${encodeURIComponent(name)}`;

export async function saveKey(_prev: KeyActionState, form: FormData): Promise<KeyActionState> {
  await requireUser();
  const result = await apiPut<{ verified: boolean }>(path(String(form.get('name'))), {
    value: String(form.get('value') ?? ''),
  });
  revalidatePath('/settings');
  revalidatePath('/overview');
  if (!result.ok) return { ok: false, message: result.error };
  return {
    ok: true,
    message: result.data.verified
      ? 'Saved and verified with OpenAI. In use now.'
      : 'Saved. In use now.',
  };
}

export async function removeKey(_prev: KeyActionState, form: FormData): Promise<KeyActionState> {
  await requireUser();
  const result = await apiDelete(path(String(form.get('name'))));
  revalidatePath('/settings');
  revalidatePath('/overview');
  return result.ok ? { ok: true, message: 'Removed.' } : { ok: false, message: result.error };
}
