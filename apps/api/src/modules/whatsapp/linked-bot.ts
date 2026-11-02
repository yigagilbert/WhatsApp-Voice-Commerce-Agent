import type { ApiConfig } from '@vca/config';
import { HEADERS } from '@vca/shared';

/** The bot number currently linked to the WhatsApp worker, e.g. "256700000000@c.us", or null. */
export async function linkedBot(config: ApiConfig): Promise<string | null> {
  if (!config.WHATSAPP_GATEWAY_URL) return null;
  try {
    const res = await fetch(`${config.WHATSAPP_GATEWAY_URL.replace(/\/$/, '')}/internal/session`, {
      headers: { [HEADERS.internalToken]: config.INTERNAL_SERVICE_TOKEN },
      signal: AbortSignal.timeout(5_000),
    });
    return ((await res.json()) as { botId?: string | null }).botId ?? null;
  } catch {
    return null;
  }
}
