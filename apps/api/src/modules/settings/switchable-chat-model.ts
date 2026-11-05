import {
  OpenAICompatibleChatModel,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatModel,
} from '@vca/ai';
import { ProviderError } from '@vca/shared';

interface Options {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** The key in effect right now. */
  apiKey: () => string | undefined;
}

/**
 * The chat model every service holds. It reads the current key on each call, so a key changed in the
 * dashboard takes effect at once, with no restart, and with no key the services see it as unavailable.
 */
export class SwitchableChatModel implements ChatModel {
  readonly id: string;
  private current: { key: string; model: OpenAICompatibleChatModel } | null = null;

  constructor(private readonly options: Options) {
    this.id = `openai-compatible:${options.model}`;
  }

  get available(): boolean {
    return !!this.options.apiKey();
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const key = this.options.apiKey();
    if (!key) throw new ProviderError('AI', 'No AI key is configured');
    if (this.current?.key !== key) {
      this.current = {
        key,
        model: new OpenAICompatibleChatModel({
          baseUrl: this.options.baseUrl,
          apiKey: key,
          model: this.options.model,
          timeoutMs: this.options.timeoutMs,
        }),
      };
    }
    return this.current.model.complete(request);
  }
}
