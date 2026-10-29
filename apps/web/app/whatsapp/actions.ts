'use server';

import { revalidatePath } from 'next/cache';
import { apiPost, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type ShopActionState = { ok: boolean; message: string } | null;

/** Restarts the WhatsApp Web session (keeps the linked device). */
export async function reconnectWhatsApp(): Promise<ShopActionState> {
  await requireUser();
  const result = await apiPost('/api/whatsapp/session/reconnect', {});
  revalidatePath('/whatsapp');
  return result.ok
    ? { ok: true, message: 'Reconnecting… this page updates on its own.' }
    : { ok: false, message: result.error };
}

/** Unlinks the bot's device from WhatsApp; a new QR appears for pairing. */
export async function logoutWhatsApp(): Promise<ShopActionState> {
  await requireUser();
  const result = await apiPost('/api/whatsapp/session/logout', {});
  revalidatePath('/whatsapp');
  return result.ok
    ? { ok: true, message: 'Unlinking… a new QR code will appear for pairing.' }
    : { ok: false, message: result.error };
}

/** Connects the currently linked bot number to this business. */
export async function connectShopNumber(): Promise<ShopActionState> {
  await requireUser();
  const result = await apiPost('/api/whatsapp/account/connect', {});
  revalidatePath('/whatsapp');
  return result.ok
    ? { ok: true, message: 'This WhatsApp number is now your shop number.' }
    : { ok: false, message: result.error };
}

export async function saveShopSettings(
  _prev: ShopActionState,
  form: FormData,
): Promise<ShopActionState> {
  await requireUser();
  const id = String(form.get('id'));
  const result = await apiPut(`/api/whatsapp/account/${encodeURIComponent(id)}`, {
    customerCommerceEnabled: form.get('customerCommerceEnabled') === 'on',
    paymentLinkMode: form.get('paymentLinkMode') === 'APPROVAL' ? 'APPROVAL' : 'AUTO',
    handoffHours: Number(form.get('handoffHours') ?? 12),
    shopInfo: String(form.get('shopInfo') ?? '').trim() || null,
    deliveryEnabled: form.get('deliveryEnabled') === 'on',
    deliveryFee: String(form.get('deliveryFee') ?? '0').trim() || '0',
    pickupEnabled: form.get('pickupEnabled') === 'on',
    pickupInfo: String(form.get('pickupInfo') ?? '').trim() || null,
  });
  revalidatePath('/whatsapp');
  return result.ok ? { ok: true, message: 'Saved.' } : { ok: false, message: result.error };
}

export async function resumeCustomer(customerId: string): Promise<ShopActionState> {
  await requireUser();
  const result = await apiPost(`/api/customers/${encodeURIComponent(customerId)}/resume`, {});
  revalidatePath('/whatsapp');
  return result.ok
    ? { ok: true, message: 'Automated replies are back on.' }
    : { ok: false, message: result.error };
}
