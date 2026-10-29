'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

/** Re-reads disputes from PayPal (reconciliation if a webhook was missed). */
export async function refreshDisputes(): Promise<void> {
  await requireUser();
  const result = await apiPost<{ synced: number }>('/api/disputes/refresh', {});
  revalidatePath('/disputes');
  // Say so when PayPal couldn't be reached instead of looking like a successful refresh.
  redirect(result.ok ? `/disputes?refreshed=${result.data.synced}` : '/disputes?refresh=failed');
}
