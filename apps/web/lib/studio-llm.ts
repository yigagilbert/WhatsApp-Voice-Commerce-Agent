/**
 * Wire format between AG Studio's LLM adapter (browser) and the /studio-ai proxy (server),
 * and the translation of one AG Studio turn into an OpenAI-compatible chat completion.
 * Pure functions, unit-tested.
 */

/** Minimal structural copies of AG Studio's conversation items (ag-studio `AgAiConversationItem`). */
export type StudioItem =
  | {
      type: 'message';
      kind: 'input';
      role: 'user' | 'system';
      content: { type: string; text?: string }[];
    }
  | {
      type: 'message';
      kind: 'output';
      role: 'assistant';
      content: { type: string; text?: string; refusal?: string }[];
    }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; callId: string; output: string }
  | { type: 'reasoning' };

export interface StudioTurnRequest {
  input: StudioItem[];
  instructions?: string;
  tools?: { name: string; description: string; parameters: object }[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?:
    { type: 'text' } | { type: 'json'; name: string; description?: string; schema: object };
}

export interface StudioTurnResult {
  id: string;
  model: string;
  text: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
  incomplete: boolean;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

const textOf = (content: { type: string; text?: string; refusal?: string }[]) =>
  content
    .map((c) => c.text ?? c.refusal ?? '')
    .filter(Boolean)
    .join('\n');

export function toChatCompletion(turn: StudioTurnRequest, model: string) {
  const messages: ChatMessage[] = [];
  if (turn.instructions) messages.push({ role: 'system', content: turn.instructions });

  for (const item of turn.input) {
    if (item.type === 'message' && item.kind === 'input') {
      messages.push({ role: item.role, content: textOf(item.content) });
    } else if (item.type === 'message' && item.kind === 'output') {
      messages.push({ role: 'assistant', content: textOf(item.content) });
    } else if (item.type === 'function_call') {
      // Consecutive tool calls belong to one assistant message.
      const last = messages.at(-1);
      const call = {
        id: item.callId,
        type: 'function' as const,
        function: { name: item.name, arguments: item.arguments || '{}' },
      };
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
    }
  }

  const tools = (turn.tools ?? []).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolChoice =
    typeof turn.toolChoice === 'object'
      ? { type: 'function' as const, function: { name: turn.toolChoice.name } }
      : turn.toolChoice;

  return {
    model,
    messages,
    ...(tools.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
    ...(turn.responseFormat?.type === 'json'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: turn.responseFormat.name,
              schema: turn.responseFormat.schema,
              strict: false,
            },
          },
        }
      : {}),
  };
}
