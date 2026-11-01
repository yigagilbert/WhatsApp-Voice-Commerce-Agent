'use server';

import { revalidatePath } from 'next/cache';
import { apiPatch, apiPost, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type ActionState = { ok: boolean; message: string } | null;

export async function saveStatusSettings(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const timezone = String(form.get('timezone') ?? '').trim();
  const result = await apiPut('/api/status-ads/settings', {
    enabled: form.get('enabled') === 'on',
    weekdays: form.getAll('weekdays').map(Number),
    times: form
      .getAll('times')
      .map(String)
      .filter((t) => t),
    timezone: timezone || null,
    approval: form.get('approval') === 'AUTO' ? 'AUTO' : 'MANUAL',
    publish: form.get('publish') === 'KATALE' ? 'KATALE' : 'PHONE',
    productIds: form.get('scope') === 'chosen' ? form.getAll('productIds').map(String) : [],
  });
  revalidatePath('/status');
  return result.ok
    ? { ok: true, message: 'Settings saved.' }
    : { ok: false, message: result.error };
}

export async function generateStatusAd(): Promise<ActionState> {
  await requireUser();
  const result = await apiPost<{ status: string; lastError: string | null }>(
    '/api/status-ads/generate',
    {},
  );
  revalidatePath('/status');
  if (!result.ok) return { ok: false, message: result.error };
  return result.data.status === 'FAILED'
    ? { ok: false, message: result.data.lastError ?? 'The advert could not be prepared.' }
    : { ok: true, message: 'New advert prepared.' };
}

export async function editStatusAd(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireUser();
  const result = await apiPatch(`/api/status-ads/${encodeURIComponent(id)}`, {
    headline: String(form.get('headline') ?? ''),
    caption: String(form.get('caption') ?? ''),
    cta: String(form.get('cta') ?? ''),
    theme: Number(form.get('theme') ?? 0),
  });
  revalidatePath('/status');
  return result.ok ? { ok: true, message: 'Saved.' } : { ok: false, message: result.error };
}

const MESSAGES = {
  approve: 'Approved: ready to post.',
  posted: 'Recorded as posted.',
  skip: 'Skipped.',
  retry: 'Tried again.',
  publish: 'Posted to your WhatsApp Status.',
} as const;

export async function statusAdAction(
  id: string,
  action: keyof typeof MESSAGES,
): Promise<ActionState> {
  await requireUser();
  const result = await apiPost<{
    status: string;
    lastError: string | null;
    publishError: string | null;
  }>(`/api/status-ads/${encodeURIComponent(id)}/${action}`, {});
  revalidatePath('/status');
  if (!result.ok) return { ok: false, message: result.error };
  if (action === 'retry' && result.data.status === 'FAILED')
    return { ok: false, message: result.data.lastError ?? 'Still failing.' };
  if (action === 'publish' && result.data.status !== 'POSTED')
    return { ok: false, message: result.data.publishError ?? 'Katale could not post it.' };
  return { ok: true, message: MESSAGES[action] };
}
