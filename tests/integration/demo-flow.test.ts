/**
 * End-to-end hackathon demo flow against a real (migrated) Postgres, with PayPal and the
 * LLM replaced by deterministic fakes:
 *
 *   WhatsApp text → agent → draft order (backend totals) → confirmation prompt →
 *   "confirm <code>" → PayPal checkout → webhook (approved) → capture → PAID →
 *   "Payment received" notification → sales summary from trusted data.
 *
 * Run: pnpm test:integration   (requires DATABASE_URL; see docs/development/local-setup.md)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  createLogger,
  type ChannelSender,
  type InboundChannelMessage,
  type OutboundChannelMessage,
} from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const merchantId = `test_merchant_${run}`;
const operatorChat = `1555${run}@c.us`;
const customerChat = `1666${run}@c.us`;

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

const textMessage = (text: string, id = randomUUID()): InboundChannelMessage => ({
  channel: 'whatsapp',
  externalMessageId: id,
  externalChatId: operatorChat,
  senderId: operatorChat,
  sentAt: new Date(),
  type: 'text',
  text,
});

const signatureHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tid',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': new Date().toISOString(),
};

describe('demo flow (integration)', () => {
  const paypal = new FakePayPal();
  const sender = new RecordingSender();
  const model = new ScriptedChatModel([
    // Turn 1: the model extracts the order — and states a WRONG total on purpose.
    () => ({
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: 'call_1',
          name: 'create_draft_order',
          arguments: JSON.stringify({
            customer: { name: 'Sarah' },
            items: [{ name: 'handmade baskets', quantity: 50, unit_price: 12 }],
            shipping: 80,
            claimed_total: 700,
          }),
        },
      ],
    }),
    () => ({ role: 'assistant', content: 'Draft created, total is $700!' }),
    // Turn 2: sales question → trusted analytics tool.
    () => ({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_2', name: 'get_sales_summary', arguments: '{"period":"this_week"}' }],
    }),
    (req) => {
      const last = req.messages.at(-1);
      const result = JSON.parse(last && 'content' in last ? (last.content ?? '{}') : '{}');
      return {
        role: 'assistant',
        content: `You sold ${result.data.revenue[0].formatted} this week.`,
      };
    },
  ]);

  let container: Container;
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it', level: 'silent' }), {
      paypal,
      chatModel: model,
      speech: null,
      channels: new ChannelRegistry().register(sender),
    });
    app = await buildApp(container);

    const db = container.db;
    await db.merchant.create({
      data: {
        id: merchantId,
        businessName: 'Test Crafts',
        ownerName: 'Owner',
        preferredCurrency: 'USD',
        timezone: 'Africa/Kampala',
      },
    });
    await db.merchantOperator.create({
      data: { merchantId, name: 'Owner', channel: 'whatsapp', externalId: operatorChat },
    });
    await db.product.create({
      data: {
        merchantId,
        name: 'Handmade Basket',
        sku: `B-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
        stockQuantity: 500,
      },
    });
    await db.customer.create({
      data: { merchantId, name: 'Sarah Thompson', whatsappId: customerChat },
    });
  });

  afterAll(async () => {
    const db = container.db;
    await db.order.deleteMany({ where: { merchantId } });
    await db.merchant.delete({ where: { id: merchantId } });
    await db.webhookEvent.deleteMany({ where: { eventId: { startsWith: `WH-${run}` } } });
    await app.close();
    await container.close();
  });

  let code = '';

  it('ignores unknown senders', async () => {
    const result = await container.inbound.handle({
      ...textMessage('hi'),
      senderId: 'stranger@c.us',
      externalChatId: 'stranger@c.us',
    });
    expect(result.status).toBe('ignored');
    // A clear onboarding reply that echoes the sender's own ID — and nothing else happens.
    expect(result.replies[0]!.text).toContain("isn't linked to a Katale AI merchant account");
    expect(result.replies[0]!.text).toContain('stranger@c.us');
    expect(
      await container.db.conversation.count({ where: { externalChatId: 'stranger@c.us' } }),
    ).toBe(0);
    // Throttled: a second message within the window gets no reply (no reply loops/spam).
    const again = await container.inbound.handle({
      ...textMessage('hello?'),
      senderId: 'stranger@c.us',
      externalChatId: 'stranger@c.us',
    });
    expect(again.replies).toEqual([]);
  });

  it('drafts the order with backend-calculated totals and asks for confirmation', async () => {
    const message = textMessage(
      'Create an order for Sarah for 50 handmade baskets at $12 each and add $80 shipping.',
    );
    const result = await container.inbound.handle(message);
    const reply = result.replies[0]!.text;

    expect(reply.startsWith('*Katale AI*')).toBe(true);
    expect(reply).toContain('50 × Handmade Basket @ $12.00 — $600.00');
    expect(reply).toContain('Shipping — $80.00');
    expect(reply).toContain('*Total — $680.00*');
    expect(reply).toContain('differs from the calculated total $680.00'); // AI's $700 was overridden
    expect(reply).not.toContain('$700!'); // the model's own text is not shown for proposals
    code = /CONFIRM (\d{4})/.exec(reply)![1]!;

    const order = await container.db.order.findFirstOrThrow({ where: { merchantId } });
    expect(order).toMatchObject({ status: 'DRAFT', totalMinor: 68000 });
    expect(paypal.created).toHaveLength(0); // nothing sent to PayPal before confirmation

    // Redelivery of the same WhatsApp message is detected.
    expect(await container.inbound.handle(message)).toEqual({ status: 'duplicate', replies: [] });
  });

  it('rejects a wrong code, then executes on the right one exactly once', async () => {
    const wrong = await container.inbound.handle(
      textMessage(`confirm ${code === '1111' ? '2222' : '1111'}`),
    );
    expect(wrong.replies[0]!.text).toMatch(/doesn't match/);
    expect(paypal.created).toHaveLength(0);

    const ok = await container.inbound.handle(textMessage(`confirm ${code}`));
    expect(ok.replies[0]!.text).toContain('https://www.sandbox.paypal.com/checkoutnow?token=PP-1');
    expect(paypal.created).toHaveLength(1);
    expect(paypal.created[0]).toMatchObject({
      total: '680.00',
      itemTotal: '600.00',
      shipping: '80.00',
      currency: 'USD',
    });

    // The customer received the link on WhatsApp.
    expect(
      sender.sent.some((m) => m.externalChatId === customerChat && m.text.includes('token=PP-1')),
    ).toBe(true);

    const again = await container.inbound.handle(textMessage(`confirm ${code}`));
    // A repeated confirmation reports the existing request; it never executes again.
    expect(again.replies[0]!.text).toContain('That payment request was already created');
    expect(again.replies[0]!.text).toContain('token=PP-1');
    expect(paypal.created).toHaveLength(1);

    const order = await container.db.order.findFirstOrThrow({ where: { merchantId } });
    expect(order.status).toBe('AWAITING_PAYMENT');
  });

  it('captures on the approval webhook, marks the order paid and notifies the merchant once', async () => {
    const approved = {
      id: `WH-${run}-1`,
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: 'PP-1' },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: approved,
    });
    expect(res.json()).toMatchObject({ outcome: 'processed' });
    expect(paypal.captures).toEqual(['PP-1']);

    const order = await container.db.order.findFirstOrThrow({
      where: { merchantId },
      include: { payments: true },
    });
    expect(order.status).toBe('PAID');
    expect(order.payments[0]).toMatchObject({ status: 'COMPLETED', captureId: 'CAP-PP-1' });

    const notices = () =>
      sender.sent.filter(
        (m) => m.externalChatId === operatorChat && m.text.includes('Payment received'),
      );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.text).toContain('Customer: Sarah Thompson');
    expect(notices()[0]!.text).toContain('Amount: $680.00');
    expect(notices()[0]!.text).toContain('The order is now marked as paid.');

    // Redelivery and the follow-up capture event cause no duplicate side effects.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: approved,
    });
    expect(dup.json()).toMatchObject({ outcome: 'duplicate' });
    const completed = {
      id: `WH-${run}-2`,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-PP-1',
        status: 'COMPLETED',
        supplementary_data: { related_ids: { order_id: 'PP-1' } },
      },
    };
    await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: completed,
    });
    expect(notices()).toHaveLength(1);
    expect(paypal.captures).toHaveLength(1);
  });

  it('answers sales questions from trusted backend data', async () => {
    const result = await container.inbound.handle(textMessage('How much have I sold this week?'));
    expect(result.replies[0]!.text).toBe('You sold $680.00 this week.');
  });

  // --- Scenarios added for the real-PayPal vertical slice: go through HTTP like the console does.

  const postMessage = async (text: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: textMessage(text),
    });
    return (res.json() as { replies: { text: string }[] }).replies[0]!.text;
  };

  const draftOrder = async (quantity: number) => {
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: `draft-${quantity}`,
            name: 'create_draft_order',
            arguments: JSON.stringify({
              customer: { name: 'Sarah' },
              items: [{ name: 'baskets', quantity, unit_price: 12 }],
              shipping: 20,
            }),
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'Draft ready.' }),
    );
    const reply = await postMessage(
      `Create an order for Sarah for ${quantity} baskets at $12 each and $20 shipping.`,
    );
    return { reply, code: /CONFIRM (\d{4})/.exec(reply)![1]! };
  };

  const paymentFor = (reference: string) =>
    container.db.payment.findFirstOrThrow({ where: { order: { reference } } });

  it('rejects an expired confirmation code', async () => {
    const { code } = await draftOrder(3);
    await container.db.actionConfirmation.updateMany({
      where: { merchantId, code, status: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const before = paypal.created.length;
    expect(await postMessage(`confirm ${code}`)).toMatch(/expired/);
    expect(paypal.created).toHaveLength(before);
  });

  it('captures via the return URL exactly once and keeps one trace ID end to end', async () => {
    const { reply, code } = await draftOrder(10);
    expect(reply).toContain('*Total — $140.00*');
    const reference = /Draft order (ORD-\w+)/.exec(reply)![1]!;

    const confirmed = await postMessage(`confirm ${code}`);
    expect(confirmed).toContain(`Order: ${reference}`);
    expect(confirmed).toContain('Amount: $140.00');
    expect(confirmed).toContain('Pay securely with PayPal:');

    const payment = await paymentFor(reference);
    expect(payment).toMatchObject({ status: 'CREATED', providerStatus: 'PAYER_ACTION_REQUIRED' });
    const notices = () =>
      sender.sent.filter((m) => m.text.includes(reference) && m.text.includes('Payment received'));

    const capturesBefore = paypal.captures.length;
    const first = await app.inject({
      method: 'GET',
      url: `/api/paypal/return?token=${payment.externalId}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Thank you');
    const second = await app.inject({
      method: 'GET',
      url: `/api/paypal/return?token=${payment.externalId}`,
    });
    expect(second.statusCode).toBe(200);

    expect(paypal.captures.length - capturesBefore).toBe(1);
    expect(notices()).toHaveLength(1);
    const paid = await paymentFor(reference);
    expect(paid).toMatchObject({ status: 'COMPLETED', providerStatus: 'COMPLETED' });

    // One trace ID from the drafting request through PayPal and capture.
    const confirmation = await container.db.actionConfirmation.findUniqueOrThrow({
      where: { id: payment.idempotencyKey },
    });
    expect(paid.correlationId).toBeTruthy();
    expect(paid.correlationId).toBe(confirmation.correlationId);
    const traced = await container.db.auditEvent.findMany({
      where: { correlationId: paid.correlationId },
    });
    expect(traced.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'order.drafted',
        'confirmation.proposed',
        'payment.requested',
        'payment.completed',
      ]),
    );
  });

  it('syncs from PayPal when an order was already captured elsewhere', async () => {
    const { reply, code } = await draftOrder(5);
    const reference = /Draft order (ORD-\w+)/.exec(reply)![1]!;
    await postMessage(`confirm ${code}`);
    const payment = await paymentFor(reference);
    paypal.capturedElsewhere.add(payment.externalId!);

    const res = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: {
        id: `WH-${run}-3`,
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: payment.externalId },
      },
    });
    expect(res.json()).toMatchObject({ outcome: 'processed' });
    expect(await paymentFor(reference)).toMatchObject({
      status: 'COMPLETED',
      captureId: `CAP-${payment.externalId}`,
    });
  });

  it('routes a bare "yes" to the agent when nothing is pending (and never executes anything)', async () => {
    model.enqueue(() => ({ role: 'assistant', content: 'Great — what would you like to order?' }));
    const before = paypal.created.length;
    expect(await postMessage('yes')).toBe('Great — what would you like to order?');
    expect(paypal.created).toHaveLength(before);
  });

  it('refuses payment requests above the policy limit with a backend-generated reply', async () => {
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'over-limit',
            name: 'create_draft_order',
            arguments: JSON.stringify({
              customer: { name: 'Sarah' },
              items: [{ name: 'baskets', quantity: 10, unit_price: 1000 }],
              shipping: 50,
            }),
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'Model paraphrase that must not be shown.' }),
    );
    const pendingBefore = await container.db.actionConfirmation.count({
      where: { merchantId, status: 'PENDING' },
    });
    const reply = await postMessage(
      'Create an order for Sarah for 10 baskets at $1000 each plus $50 shipping.',
    );
    expect(reply).toContain('*Total — $10,050.00*');
    expect(reply).toContain('⛔ Payment requests above $10,000.00 are not allowed.');
    expect(reply).toContain('catalog price $12.00');
    expect(reply).not.toContain('paraphrase');
    expect(
      await container.db.actionConfirmation.count({ where: { merchantId, status: 'PENDING' } }),
    ).toBe(pendingBefore);
  });

  // --- WhatsApp text phase ---------------------------------------------------------------

  const deliver = (message: InboundChannelMessage) =>
    app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: message,
    });

  it('replies politely to unsupported content without calling the LLM', async () => {
    const llmCalls = model.requests.length;
    const res = await deliver({
      ...textMessage(''),
      type: 'unsupported',
      unsupportedKind: 'image',
      text: undefined,
    });
    const body = res.json() as { replies: { text: string }[] };
    expect(body.replies[0]!.text).toContain("I can't read images yet");
    expect(model.requests.length).toBe(llmCalls);
  });

  it('answers undownloaded voice notes (voice disabled in the worker) with "coming soon"', async () => {
    const res = await deliver({
      ...textMessage(''),
      type: 'unsupported',
      unsupportedKind: 'voice',
      text: undefined,
    });
    expect((res.json() as { replies: { text: string }[] }).replies[0]!.text).toContain(
      'Voice messages are coming soon',
    );
  });

  it('answers voice notes with "coming soon" while the voice pipeline is disabled', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]).toString('base64');
    const res = await deliver({
      ...textMessage(''),
      type: 'audio',
      text: undefined,
      media: { mimeType: 'audio/ogg; codecs=opus', dataBase64: ogg },
    });
    expect((res.json() as { replies: { text: string }[] }).replies[0]!.text).toContain(
      'Voice messages are coming soon',
    );
  });

  it('ignores redelivered WhatsApp messages: no second order, confirmation or PayPal order', async () => {
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'dup-draft',
            name: 'create_draft_order',
            arguments: JSON.stringify({
              customer: { name: 'Sarah' },
              items: [{ name: 'baskets', quantity: 7, unit_price: 12 }],
            }),
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'ok' }),
    );
    const orderMessage = textMessage('Create an order for Sarah for 7 baskets at $12 each.');
    const ordersBefore = await container.db.order.count({ where: { merchantId } });
    const first = (await deliver(orderMessage)).json() as {
      status: string;
      replies: { text: string }[];
    };
    const redelivered = (await deliver(orderMessage)).json() as { status: string };
    expect(redelivered.status).toBe('duplicate');
    expect(await container.db.order.count({ where: { merchantId } })).toBe(ordersBefore + 1);

    const code = /CONFIRM (\d{4})/.exec(first.replies[0]!.text)![1]!;
    const confirmMessage = textMessage(`CONFIRM ${code}`);
    const paypalBefore = paypal.created.length;
    await deliver(confirmMessage);
    const confirmAgain = (await deliver(confirmMessage)).json() as { status: string };
    expect(confirmAgain.status).toBe('duplicate');
    expect(paypal.created.length).toBe(paypalBefore + 1);
  });

  it('kept an audit trail of the whole journey', async () => {
    const types = (
      await container.db.auditEvent.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'order.drafted',
        'confirmation.proposed',
        'agent.intent_interpreted',
        'confirmation.received',
        'payment.requested',
        'payment.completed',
      ]),
    );
  });
});
