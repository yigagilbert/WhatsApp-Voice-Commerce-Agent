'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

/** Re-reads disputes from PayPal (reconciliation if a webhook was missed). */
export async function refreshDisputes(): Promise<void> {
  await requireUser();
  await apiPost<{ synced: number }>('/api/disputes/refresh', {});
  revalidatePath('/disputes');
}
