import type {
  AgAiEvent,
  AgAiOutputItem,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
} from 'ag-studio';
import type { StudioTurnResult } from '@/lib/studio-llm';

/**
 * AG Studio LLM adapter that sends each turn to Katale's /studio-ai route (same origin,
 * session cookie) instead of calling a provider from the browser.
 */
export const kataleProxyAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions) {
    const result: Promise<StudioTurnResult | { error: { code: string; message: string } }> = fetch(
      '/studio-ai',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: request.input,
          instructions: request.instructions,
          tools: request.tools?.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          toolChoice: request.toolChoice,
          responseFormat: request.responseFormat,
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          StudioTurnResult | { error: { code: string; message: string } } | null;
        return body ?? { error: { code: 'bad_response', message: `HTTP ${res.status}` } };
      })
      .catch((error: unknown) => ({
        error: {
          code: 'network',
          message: error instanceof Error ? error.message : 'Network error',
        },
      }));

    const complete: Promise<AgLlmResponse> = result.then((r) => {
      if ('error' in r) {
        return {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          status: 'failed',
          error: r.error,
          output: [],
        };
      }
      const output: AgAiOutputItem[] = [];
      if (r.text) {
        output.push({
          id: `${r.id}-msg`,
          kind: 'output',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'text', text: r.text, annotations: [] }],
        });
      }
      for (const call of r.toolCalls) {
        output.push({
          id: `${r.id}-${call.callId}`,
          kind: 'output',
          type: 'function_call',
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        });
      }
      return {
        id: r.id,
        createdAt: Date.now(),
        status: r.incomplete ? 'incomplete' : 'completed',
        ...(r.incomplete ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
        output,
        usage: r.usage,
        model: r.model,
      };
    });

    async function* events(): AsyncGenerator<AgAiEvent> {
      const r = await result;
      if ('error' in r) return;
      if (r.text) {
        const messageId = `${r.id}-msg`;
        yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: r.text };
        yield { type: 'TEXT_MESSAGE_END', messageId };
      }
      for (const call of r.toolCalls) {
        yield { type: 'TOOL_CALL_START', toolCallId: call.callId, toolCallName: call.name };
        yield { type: 'TOOL_CALL_ARGS', toolCallId: call.callId, delta: call.arguments };
        yield { type: 'TOOL_CALL_END', toolCallId: call.callId };
      }
    }

    return { stream: { [Symbol.asyncIterator]: () => events() }, complete };
  },
};
