import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './agent';
import { defineTool, ToolRegistry } from './tools';
import type { ChatCompletionRequest, ChatCompletionResponse, ChatModel } from './types';

/** Scripted model: returns queued responses and records requests. */
class ScriptedModel implements ChatModel {
  readonly id = 'scripted';
  readonly requests: ChatCompletionRequest[] = [];
  constructor(private readonly script: ChatCompletionResponse['message'][]) {}
  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.requests.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error('script exhausted');
    return { message };
  }
}

const registry = () =>
  new ToolRegistry<{ calls: number }>().register(
    defineTool({
      name: 'add_numbers',
      kind: 'read',
      description: 'Adds two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }, ctx) {
        ctx.calls++;
        return { sum: a + b };
      },
    }),
  );

describe('ToolRegistry', () => {
  it('exposes JSON-schema specs', () => {
    const [spec] = registry().specs();
    expect(spec?.name).toBe('add_numbers');
    expect(spec?.parameters).toMatchObject({
      type: 'object',
      properties: { a: { type: 'number' } },
    });
    expect(spec?.parameters).not.toHaveProperty('$schema');
  });

  it('validates arguments before executing', async () => {
    const ctx = { calls: 0 };
    expect(await registry().execute('add_numbers', '{"a":1}', ctx)).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(await registry().execute('add_numbers', 'not json', ctx)).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(await registry().execute('nope', '{}', ctx)).toMatchObject({
      ok: false,
      code: 'UNKNOWN_TOOL',
    });
    expect(ctx.calls).toBe(0);
  });

  it('rejects duplicate or malformed tool names', () => {
    expect(() => registry().register(registry().get('add_numbers')!)).toThrow(/already registered/);
  });
});

describe('runAgent', () => {
  it('runs tool calls and feeds results back to the model', async () => {
    const model = new ScriptedModel([
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'add_numbers', arguments: '{"a":2,"b":3}' }],
      },
      { role: 'assistant', content: 'The sum is 5.' },
    ]);
    const ctx = { calls: 0 };
    const result = await runAgent({
      model,
      tools: registry(),
      systemPrompt: 'sys',
      history: [],
      userMessage: 'add 2 and 3',
      context: ctx,
    });

    expect(result).toMatchObject({ reply: 'The sum is 5.', stoppedReason: 'completed' });
    expect(result.steps).toHaveLength(1);
    expect(ctx.calls).toBe(1);
    const toolMessage = model.requests[1]?.messages.at(-1);
    expect(toolMessage).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      content: JSON.stringify({ ok: true, data: { sum: 5 } }),
    });
  });

  it('stops after the step budget', async () => {
    const call = {
      role: 'assistant' as const,
      content: null,
      toolCalls: [{ id: 'c', name: 'add_numbers', arguments: '{"a":1,"b":1}' }],
    };
    const model = new ScriptedModel([call, call, call]);
    const result = await runAgent({
      model,
      tools: registry(),
      systemPrompt: '',
      history: [],
      userMessage: 'loop',
      context: { calls: 0 },
      maxSteps: 2,
    });
    expect(result.stoppedReason).toBe('max_steps');
  });
});
