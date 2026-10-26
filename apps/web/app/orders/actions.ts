'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

/**
 * Cancels an unpaid order (the merchant's click is the approval). The API asks PayPal first: an
 * order the buyer has just paid is recorded as paid instead of being cancelled.
 */
export async function cancelOrder(reference: string): Promise<{ ok: boolean; message: string }> {
  await requireUser();
  const result = await apiPost<{ status: 'cancelled' | 'already_cancelled' | 'paid' }>(
    `/api/orders/${encodeURIComponent(reference)}/cancel`,
    {},
  );
  revalidatePath('/orders');
  revalidatePath('/');
  if (!result.ok) return { ok: false, message: result.error };
  switch (result.data.status) {
    case 'cancelled':
      return {
        ok: true,
        message: `${reference} is cancelled. Its stock is available again and the PayPal link no longer works.`,
      };
    case 'already_cancelled':
      return { ok: true, message: `${reference} was already cancelled.` };
    case 'paid':
      return {
        ok: false,
        message: `${reference} was not cancelled: PayPal shows it has just been paid. It is now recorded as paid.`,
      };
  }
}
