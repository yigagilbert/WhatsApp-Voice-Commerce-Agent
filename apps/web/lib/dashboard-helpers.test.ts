import { describe, expect, it } from 'vitest';
import { describeEvent } from './activity';
import { buildInsights } from './insights';
import { toChatCompletion } from './studio-llm';
import type { DashboardSummary } from './types';

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

const money = (formatted: string, amountMinor: number) => ({
  currency: 'USD',
  amountMinor,
  formatted,
});

describe('buildInsights (Overview highlights)', () => {
  it('only quotes figures the API computed', () => {
    const summary = {
      revenue: [{ ...money('$286.00', 28_600), count: 3 }],
      revenueThisWeek: [{ ...money('$286.00', 28_600), count: 3 }],
      outstanding: [{ ...money('$60.00', 6_000), count: 1 }],
      averageOrderValue: [money('$95.33', 9_533)],
      topProducts: [
        { ...money('$120.00', 12_000), name: 'Handmade Basket', quantity: 10, sharePercent: 46.9 },
        { ...money('$100.00', 10_000), name: 'Coffee Gift Pack', quantity: 4, sharePercent: 39.1 },
      ],
      topCustomers: [{ ...money('$250.00', 25_000), name: 'Sarah Thompson', orders: 2 }],
      bySource: [
        { ...money('$250.00', 25_000), name: 'WhatsApp voice', orders: 2 },
        { ...money('$36.00', 3_600), name: 'WhatsApp text', orders: 1 },
      ],
      operations: {
        awaitingShipment: 2,
        shipped: 1,
        openDisputes: 1,
        needsResponse: 1,
        disputedAmount: [],
      },
      counts: {
        orders: 5,
        paidOrders: 3,
        awaitingPayment: 1,
        drafts: 1,
        customers: 2,
        products: 3,
      },
    } as unknown as DashboardSummary;
    expect(buildInsights(summary)).toEqual([
      '3 paid orders so far, $286.00 received ($286.00 this week).',
      'Handmade Basket is your best seller: 46.9% of product revenue ($120.00).',
      'Voice notes brought in $250.00 across 2 paid orders.',
      'Sarah Thompson is your top customer ($250.00).',
      '$60.00 is still outstanding across 1 order awaiting payment.',
      '2 paid orders are waiting for shipping and tracking.',
      '1 PayPal dispute needs your response.',
    ]);
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
