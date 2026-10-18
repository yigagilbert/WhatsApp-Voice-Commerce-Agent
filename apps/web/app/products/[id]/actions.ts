'use server';

import { revalidatePath } from 'next/cache';
import { apiDelete, apiPatch, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type ActionState = { ok: boolean; message: string } | null;

const MAX_BYTES = 1_000_000;

export async function saveProductDetails(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const id = String(form.get('id'));
  const result = await apiPatch(`/api/products/${encodeURIComponent(id)}`, {
    description: String(form.get('description') ?? '').trim() || null,
    visibleToCustomers: form.get('visibleToCustomers') === 'on',
  });
  revalidatePath(`/products/${id}`);
  return result.ok ? { ok: true, message: 'Saved.' } : { ok: false, message: result.error };
}

export async function uploadPhoto(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const id = String(form.get('id'));
  const file = form.get('photo');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Choose a photo first.' };
  if (file.type !== 'image/jpeg' && file.type !== 'image/png')
    return { ok: false, message: 'Upload a JPEG or PNG photo.' };
  if (file.size > MAX_BYTES)
    return { ok: false, message: 'Photos must be 1 MB or smaller. Try a smaller JPEG.' };
  const dataBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  const result = await apiPut(`/api/products/${encodeURIComponent(id)}/image`, {
    mimeType: file.type,
    dataBase64,
  });
  revalidatePath(`/products/${id}`);
  return result.ok
    ? { ok: true, message: 'Photo uploaded.' }
    : { ok: false, message: result.error };
}

export async function removePhoto(id: string): Promise<ActionState> {
  await requireUser();
  const result = await apiDelete(`/api/products/${encodeURIComponent(id)}/image`);
  revalidatePath(`/products/${id}`);
  return result.ok ? { ok: true, message: 'Photo removed.' } : { ok: false, message: result.error };
}
