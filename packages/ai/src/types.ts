/**
 * Provider-neutral chat + tool-calling contracts. Every LLM provider (OpenAI-compatible,
 * Anthropic, Gemini, local models) is adapted to these types; nothing above this layer
 * knows which provider is in use.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string produced by the model. Always validated before use. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
}

export interface ChatCompletionResponse {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatModel {
  /** e.g. "openai-compatible:gpt-4.1-mini" — for logs and audit. */
  readonly id: string;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
