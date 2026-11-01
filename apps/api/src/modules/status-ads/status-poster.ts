import { HEADERS, getCorrelationId, type StatusPost } from '@vca/shared';

/**
 * How a post attempt ended. `unknown` means the request may have reached WhatsApp (timeout,
 * dropped connection), so the advert must not be posted again automatically.
 */
export type StatusPostResult =
  | { outcome: 'posted'; messageId: string | null }
  | { outcome: 'failed' | 'unknown'; reason: string };

/** Posts to the shop's own WhatsApp Status. Implemented over the worker's internal gateway. */
export interface StatusPoster {
  post(post: StatusPost): Promise<StatusPostResult>;
}

/**
 * Calls the WhatsApp worker's /internal/status route. The worker checks that one of `botIds` is
 * the connected number before posting, and its customer send route refuses the Status chat, so
 * this is the only way an advert reaches WhatsApp.
 */
export class HttpStatusPoster implements StatusPoster {
  constructor(
    private readonly gatewayUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(post: StatusPost): Promise<StatusPostResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl.replace(/\/$/, '')}/internal/status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADERS.internalToken]: this.internalToken,
          [HEADERS.correlationId]: getCorrelationId() ?? '',
        },
        body: JSON.stringify(post),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      // A refused connection never reached WhatsApp; a timeout may have.
      const refused = (error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED';
      return refused
        ? { outcome: 'failed', reason: 'The WhatsApp worker is not running.' }
        : {
            outcome: 'unknown',
            reason:
              'No answer from the WhatsApp worker. The status may or may not have been posted: check the shop phone before posting it again.',
          };
    }
    const body = (await response.json().catch(() => ({}))) as {
      messageId?: string | null;
      error?: string;
    };
    if (response.status === 202) return { outcome: 'posted', messageId: body.messageId ?? null };
    const reason =
      response.status === 503
        ? 'WhatsApp is not connected.'
        : (body.error ?? `The WhatsApp worker answered HTTP ${response.status}.`);
    return { outcome: 'failed', reason };
  }
}
