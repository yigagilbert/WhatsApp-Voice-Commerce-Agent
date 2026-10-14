import {
  HEADERS,
  ProviderError,
  type InboundChannelMessage,
  type InboundProcessingResult,
} from '@vca/shared';

/** Forwards normalized messages to the core API. The worker holds no business logic. */
export class CoreApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async forward(
    message: InboundChannelMessage,
    correlationId: string,
  ): Promise<InboundProcessingResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/agent/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADERS.internalToken]: this.internalToken,
          [HEADERS.correlationId]: correlationId,
        },
        body: JSON.stringify(message),
        // Speech + LLM + PayPal can take a while.
        signal: AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      throw new ProviderError('core-api', 'unreachable', { cause });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new ProviderError('core-api', `HTTP ${response.status}`, { details: detail });
    }
    return (await response.json()) as InboundProcessingResult;
  }
}
