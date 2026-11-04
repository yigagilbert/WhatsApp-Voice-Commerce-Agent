'use server';

import { revalidatePath } from 'next/cache';
import { apiDelete, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { photoProblem } from '@/lib/photo';

export type StorefrontState = { ok: boolean; message: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** Saves the address, publish switch and shop description. */
export async function saveStorefront(
  _prev: StorefrontState,
  form: FormData,
): Promise<StorefrontState> {
  await requireUser();
  const result = await apiPut('/api/storefront', {
    slug: text(form, 'slug').toLowerCase(),
    enabled: form.get('enabled') === 'on',
    tagline: text(form, 'tagline') || null,
    about: text(form, 'about') || null,
  });
  if (!result.ok) return { ok: false, message: result.error };
  revalidatePath('/storefront');
  return {
    ok: true,
    message:
      form.get('enabled') === 'on' ? 'Saved. Your shop is public.' : 'Saved. Your shop is private.',
  };
}

export async function uploadLogo(_prev: StorefrontState, form: FormData): Promise<StorefrontState> {
  await requireUser();
  const file = form.get('logo');
  if (!(file instanceof File) || !file.size)
    return { ok: false, message: 'Choose an image first.' };
  const problem = photoProblem(file);
  if (problem) return { ok: false, message: problem };
  const result = await apiPut('/api/storefront/logo', {
    dataBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
  });
  if (!result.ok) return { ok: false, message: result.error };
  revalidatePath('/storefront');
  return { ok: true, message: 'Logo saved.' };
}

export async function removeLogo(): Promise<void> {
  await requireUser();
  await apiDelete('/api/storefront/logo');
  revalidatePath('/storefront');
}
