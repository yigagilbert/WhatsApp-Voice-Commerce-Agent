import type { Logger } from '@vca/shared';
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
  stoppedReason: 'completed' | 'max_steps';
}

export interface RunAgentOptions<C> {
  model: ChatModel;
  tools: ToolRegistry<C>;
  systemPrompt: string;
  /** Prior conversation turns (oldest first), user/assistant only. */
  history: ChatMessage[];
  userMessage: string;
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
    { role: 'user', content: options.userMessage },
  ];
  const steps: AgentStep[] = [];

  for (let iteration = 0; iteration < maxSteps; iteration++) {
    const { message } = await options.model.complete({ messages, tools: specs });
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
