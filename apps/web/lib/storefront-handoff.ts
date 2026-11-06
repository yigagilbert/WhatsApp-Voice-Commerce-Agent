/**
 * A cart on its way to WhatsApp. Stored with the cart in localStorage, so every tab knows about it
 * and a customer can't check the same cart out twice from a new tab.
 */
export interface Handoff {
  reference: string;
  url: string;
  expiresAt: string;
  /** Whether a page opening should show it. Turned off once shown, or once the customer closes it. */
  autoOpen: boolean;
}

export const handoffStorageKey = (slug: string) => `katale-handoff:${slug}`;

/** How long past its expiry a saved hand-off is still asked about: a late WhatsApp message counts. */
const STATUS_GRACE_MS = 24 * 60 * 60 * 1000;

export const isHandoffExpired = (handoff: Pick<Handoff, 'expiresAt'>, now = Date.now()) =>
  new Date(handoff.expiresAt).getTime() <= now;

export function parseHandoff(raw: string | null, now = Date.now()): Handoff | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<Handoff>;
    if (
      typeof saved.reference !== 'string' ||
      typeof saved.url !== 'string' ||
      typeof saved.expiresAt !== 'string'
    )
      return null;
    const expires = new Date(saved.expiresAt).getTime();
    if (Number.isNaN(expires) || expires + STATUS_GRACE_MS <= now) return null;
    return {
      reference: saved.reference,
      url: saved.url,
      expiresAt: saved.expiresAt,
      // Past its expiry it is only there for one status check, never to be shown.
      autoOpen: saved.autoOpen === true && expires > now,
    };
  } catch {
    return null;
  }
}

export const afterAutoOpen = (handoff: Handoff): Handoff => ({ ...handoff, autoOpen: false });
export const afterClose = afterAutoOpen;
