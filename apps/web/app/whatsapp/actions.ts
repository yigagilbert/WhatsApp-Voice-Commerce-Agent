'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';
import { requireUser } from '@/lib/auth';

/** Restarts the WhatsApp Web session (keeps the linked device). */
export async function reconnectWhatsApp(): Promise<void> {
  await requireUser();
  await apiPost('/api/whatsapp/session/reconnect', {});
  revalidatePath('/whatsapp');
}

/** Unlinks the bot's device from WhatsApp; a new QR appears for pairing. */
export async function logoutWhatsApp(): Promise<void> {
  await requireUser();
  await apiPost('/api/whatsapp/session/logout', {});
  revalidatePath('/whatsapp');
}
