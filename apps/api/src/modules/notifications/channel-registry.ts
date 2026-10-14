import {
  HEADERS,
  ProviderError,
  getCorrelationId,
  type Channel,
  type ChannelSender,
  type OutboundChannelMessage,
} from '@vca/shared';

/** Outbound senders by channel. Core services push messages without knowing channel details. */
export class ChannelRegistry {
  private readonly senders = new Map<Channel, ChannelSender>();

  register(sender: ChannelSender): this {
    this.senders.set(sender.channel, sender);
    return this;
  }

  get(channel: string): ChannelSender | undefined {
    return this.senders.get(channel as Channel);
  }
}

/**
 * Delivers messages through the WhatsApp worker's internal gateway. The API never imports
 * whatsapp-web.js — the worker owns the browser session; this is just an HTTP call.
 */
export class HttpWhatsAppSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;

  constructor(
    private readonly gatewayUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: OutboundChannelMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl.replace(/\/$/, '')}/internal/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADERS.internalToken]: this.internalToken,
          [HEADERS.correlationId]: getCorrelationId() ?? '',
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new ProviderError('whatsapp-gateway', 'unreachable', { cause });
    }
    if (!response.ok) throw new ProviderError('whatsapp-gateway', `HTTP ${response.status}`);
  }
}
