import { ProviderError } from '@vca/shared';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatModel,
  ToolCall,
} from './types';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

/**
 * Chat model for any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, LM Studio, ...).
 * Implemented with fetch to keep the dependency surface small.
 */
export class OpenAICompatibleChatModel implements ChatModel {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = `openai-compatible:${options.model}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = {
      model: this.options.model,
      messages: request.messages.map(toOpenAIMessage),
      temperature: request.temperature ?? 0.1,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto',
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        },
      );
    } catch (cause) {
      throw new ProviderError('llm', 'request failed', { cause });
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new ProviderError('llm', `HTTP ${response.status}`, { details: detail });
    }

    const json = (await response.json()) as OpenAIChatResponse;
    const choice = json.choices?.[0]?.message;
    if (!choice) throw new ProviderError('llm', 'response contained no choices');

    const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));

    return {
      message: {
        role: 'assistant',
        content: choice.content ?? null,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      ...(json.usage
        ? {
            usage: {
              inputTokens: json.usage.prompt_tokens ?? 0,
              outputTokens: json.usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  }
}
