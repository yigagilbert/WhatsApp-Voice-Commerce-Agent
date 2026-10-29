'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

type Outcome =
  | {
      status: 'sent';
      renewed: boolean;
      reminderNumber: number;
      customer: string;
      orderReference: string;
    }
  | { status: 'paid'; customer: string; orderReference: string }
  | { status: 'pending'; customer: string; orderReference: string };

/** Sends a payment reminder to the customer (the merchant's click is the approval). */
export async function sendReminder(paymentId: string): Promise<{ ok: boolean; message: string }> {
  await requireUser();
  const result = await apiPost<Outcome>(
    `/api/payments/${encodeURIComponent(paymentId)}/remind`,
    {},
  );
  revalidatePath('/payments');
  if (!result.ok) return { ok: false, message: result.error };
  const o = result.data;
  if (o.status === 'paid')
    return {
      ok: true,
      message: `No reminder needed: PayPal shows ${o.customer} has paid ${o.orderReference}. It's now recorded as paid.`,
    };
  if (o.status === 'pending')
    return {
      ok: true,
      message: `No reminder sent: ${o.customer} approved the payment and PayPal is completing it.`,
    };
  return {
    ok: true,
    message: `Reminder ${o.reminderNumber} sent to ${o.customer} for ${o.orderReference}.${o.renewed ? ' The old PayPal link had expired, so a new one was sent.' : ''}`,
  };
}

/**
 * Payment review: re-reads the payment from PayPal (records a payment whose webhook was missed,
 * and any refunds) — the same checks the background reconciliation runs.
 */
export async function refreshPayment(paymentId: string): Promise<{ ok: boolean; message: string }> {
  await requireUser();
  const result = await apiPost<{
    status: string;
    amountMinor: number;
    refundedMinor: number;
    currency: string;
    order: { reference: string } | undefined;
  }>(`/api/payments/${encodeURIComponent(paymentId)}/refresh`, {});
  revalidatePath('/payments');
  revalidatePath('/orders');
  if (!result.ok) return { ok: false, message: result.error };
  const p = result.data;
  const status =
    p.status === 'COMPLETED' && p.refundedMinor > 0
      ? 'partially refunded'
      : p.status.toLowerCase().replace(/_/g, ' ');
  return { ok: true, message: `Checked with PayPal: this payment is ${status}.` };
}
