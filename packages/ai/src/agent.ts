import { isAppError, type Logger } from '@vca/shared';
import type { ToolRegistry, ToolResult } from './tools';
import type { ChatMessage, ChatModel } from './types';

export interface AgentStep {
  tool: string;
  arguments: string;
  result: ToolResult;
  durationMs: number;
}

export interface AgentRunResult {
  reply: string;
  steps: AgentStep[];
  /** provider_failed: the model stopped answering after tools had already run this turn. */
  stoppedReason: 'completed' | 'max_steps' | 'provider_failed';
}

export interface RunAgentOptions<C> {
  model: ChatModel;
  tools: ToolRegistry<C>;
  systemPrompt: string;
  /** Prior conversation turns (oldest first), user/assistant only. */
  history: ChatMessage[];
  userMessage: string;
  /**
   * Facts built by the backend for this turn (what's on screen, the cart, a pending approval). Sent
   * last, after the stable prefix, so provider prompt caching still applies.
   */
  stateCard?: string;
  context: C;
  maxSteps?: number;
  logger?: Logger;
}

const FALLBACK_REPLY =
  "Sorry, I couldn't complete that. Could you rephrase or give a bit more detail?";

/**
 * Minimal tool-calling loop: ask the model, run requested tools (validated), feed results
 * back, repeat until the model answers in plain text or the step budget is exhausted.
 */
export async function runAgent<C>(options: RunAgentOptions<C>): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? 6;
  const specs = options.tools.specs();
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...options.history,
    ...(options.stateCard ? [{ role: 'system' as const, content: options.stateCard }] : []),
    { role: 'user', content: options.userMessage },
  ];
  const steps: AgentStep[] = [];

  for (let iteration = 0; iteration < maxSteps; iteration++) {
    let message: ChatMessage;
    try {
      ({ message } = await options.model.complete({ messages, tools: specs }));
    } catch (error) {
      // Tools may already have changed things. Retrying the turn would repeat them, so the caller
      // gets what ran and reports it. With nothing done yet, a plain failure is safe to surface.
      const providerDown = isAppError(error) && error.code.startsWith('PROVIDER');
      if (!providerDown || !steps.some((s) => s.result.ok)) throw error;
      options.logger?.warn({ err: error, steps: steps.length }, 'model failed after tools ran');
      return { reply: '', steps, stoppedReason: 'provider_failed' };
    }
    messages.push(message);

    if (!message.toolCalls?.length) {
      return {
        reply: message.content?.trim() || FALLBACK_REPLY,
        steps,
        stoppedReason: 'completed',
      };
    }

    for (const call of message.toolCalls) {
      const started = Date.now();
      const result = await options.tools.execute(call.name, call.arguments, options.context);
      const step = {
        tool: call.name,
        arguments: call.arguments,
        result,
        durationMs: Date.now() - started,
      };
      steps.push(step);
      options.logger?.debug(
        { tool: call.name, ok: result.ok, durationMs: step.durationMs },
        'agent tool call',
      );
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
    }
  }

  options.logger?.warn({ maxSteps }, 'agent stopped: step budget exhausted');
  return { reply: FALLBACK_REPLY, steps, stoppedReason: 'max_steps' };
}
