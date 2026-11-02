import 'server-only';
import { headers } from 'next/headers';
import { loadWebConfig } from '@vca/config';

/** The site's public origin (no trailing slash): WEB_PUBLIC_URL, else the request's own host. */
export async function siteUrl(): Promise<string> {
  try {
    const configured = loadWebConfig().WEB_PUBLIC_URL;
    if (configured) return configured.replace(/\/$/, '');
  } catch {
    // Config errors surface elsewhere; fall back to the request.
  }
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto.split(',')[0]!.trim()}://${host.split(',')[0]!.trim()}`;
}

export type PublicWhatsApp = { available: true; phone: string } | { available: false };

/**
 * The WhatsApp number an owner published for the homepage (Dashboard → WhatsApp), read from the
 * API on every request; a changed number shows up within the API's 30-second cache.
 */
export async function publicWhatsApp(): Promise<PublicWhatsApp> {
  try {
    const base = loadWebConfig().API_BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/api/public/whatsapp`, {
      // The API caches for 30 seconds; a second cache here would serve stale numbers to /chat.
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return { available: false };
    const body = (await res.json()) as { available?: boolean; phone?: unknown };
    return body.available && typeof body.phone === 'string' && /^\d{6,15}$/.test(body.phone)
      ? { available: true, phone: body.phone }
      : { available: false };
  } catch {
    return { available: false };
  }
}

/** The wa.me link that opens a chat with the published number, starting with "Hi". */
export const whatsappLink = (phone: string) =>
  `https://wa.me/${phone}?text=${encodeURIComponent('Hi')}`;

/** "+256 772 051 029"-style grouping for display only. */
export const displayPhone = (phone: string) =>
  `+${phone.slice(0, 3)} ${phone.slice(3).replace(/(\d{3})(?=\d)/g, '$1 ')}`.trim();
