import { describe, expect, it } from 'vitest';
import { describeEvent } from './activity';
import { toChatCompletion } from './studio-llm';

describe('describeEvent (Activity page)', () => {
  it('explains each step of the responsible-commerce chain in plain language', () => {
    expect(
      describeEvent({
        type: 'order.drafted',
        data: { reference: 'ORD-A', totalMinor: 14_000, currency: 'USD', warnings: [] },
      }),
    ).toEqual({
      stage: 'Backend verifies',
      title: 'Order ORD-A drafted — total calculated by the backend',
      detail: '$140.00',
    });
    expect(describeEvent({ type: 'confirmation.received', data: { code: '4821' } })).toMatchObject({
      stage: 'Merchant approves',
      title: 'Merchant typed CONFIRM 4821',
    });
    expect(
      describeEvent({ type: 'webhook.received', data: { eventType: 'PAYMENT.CAPTURE.COMPLETED' } }),
    ).toMatchObject({
      stage: 'PayPal executes',
      title: 'PayPal webhook received (signature verified)',
    });
    expect(
      describeEvent({
        type: 'agent.intent_interpreted',
        data: { tools: [{ tool: 'create_draft_order', ok: true }] },
      }).title,
    ).toBe('AI chose: draft an order');
    expect(
      describeEvent({
        type: 'speech.transcribed',
        data: { transcript: 'Create an order', audioSeconds: 5.28, confidence: 0.78, sttMs: 1700 },
      }).detail,
    ).toBe('“Create an order” · 5.3 s audio · confidence 0.78 · speech-to-text 1.7 s');
    expect(
      describeEvent({ type: 'payment.request_failed', data: { error: 'secret detail' } }),
    ).toEqual({
      stage: 'Problem',
      title: 'PayPal checkout could not be created',
    });
  });
});

describe('toChatCompletion (AG Studio → OpenAI-compatible)', () => {
  it('maps instructions, history, grouped tool calls, tool results and tool choice', () => {
    const body = toChatCompletion(
      {
        instructions: 'You build dashboards.',
        input: [
          {
            type: 'message',
            kind: 'input',
            role: 'user',
            content: [{ type: 'text', text: 'Revenue by source' }],
          },
          { type: 'function_call', callId: 'c1', name: 'viewSchema', arguments: '{}' },
          { type: 'function_call', callId: 'c2', name: 'executeQuery', arguments: '{"q":1}' },
          { type: 'function_call_output', callId: 'c1', output: 'schema' },
          { type: 'reasoning' },
          {
            type: 'message',
            kind: 'output',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
          },
        ],
        tools: [
          { name: 'addWidget', description: 'Adds a widget', parameters: { type: 'object' } },
        ],
        toolChoice: { name: 'addWidget' },
        responseFormat: { type: 'text' },
      },
      'gpt-4.1-mini',
    );
    expect(body).toEqual({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You build dashboards.' },
        { role: 'user', content: 'Revenue by source' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'viewSchema', arguments: '{}' } },
            {
              id: 'c2',
              type: 'function',
              function: { name: 'executeQuery', arguments: '{"q":1}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'schema' },
        { role: 'assistant', content: 'Done.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'addWidget',
            description: 'Adds a widget',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'addWidget' } },
    });
  });

  it('requests JSON output when AG Studio asks for a schema', () => {
    const body = toChatCompletion(
      { input: [], responseFormat: { type: 'json', name: 'plan', schema: { type: 'object' } } },
      'm',
    );
    expect(body).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'plan', schema: { type: 'object' } },
      },
    });
  });
});
