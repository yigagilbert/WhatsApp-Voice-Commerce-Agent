/**
 * The polished English merchant and buyer experience, against a real Postgres with scripted
 * speech-to-text, LLM and PayPal:
 *   - voice and text orders are tagged by input mode and reported separately in analytics;
 *   - trusted analytics (top products, top customers, voice vs text, AOV, customer summary);
 *   - order filters ("unpaid orders", "voice orders", "Sarah's orders");
 *   - a repeated CONFIRM reports the existing payment request instead of "nothing pending";
 *   - CANCEL discards the draft; a PayPal outage leaves the order as a draft, uncharged;
 *   - buyer return/cancel pages show the order without changing its state;
 *   - voice never prices a near-miss product ("buckets") without the merchant confirming.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  ProviderError,
  ValidationError,
  createLogger,
  type InboundChannelMessage,
} from '@vca/shared';
import { SpeechPipeline, type TranscriptionResult } from '../../packages/speech/src';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const merchantId = `mx_merchant_${run}`;
const operatorChat = `1888${run}@c.us`;
const dashboard = {
  authorization: 'Bearer test-dashboard-token-123456',
  'x-merchant-id': merchantId,
};
const fixture = readFileSync(join(__dirname, '../fixtures/voice/en-order-001.ogg')).toString(
  'base64',
);

describe('merchant experience (integration)', () => {
  const paypal = new FakePayPal(`MX-${run}`);
  const model = new ScriptedChatModel([]);
  let nextTranscript: TranscriptionResult = { text: '' };
  let container: Container;
  let app: FastifyInstance;

  const message = (body: Partial<InboundChannelMessage>): InboundChannelMessage => ({
    channel: 'whatsapp',
    externalMessageId: randomUUID(),
    externalChatId: operatorChat,
    senderId: operatorChat,
    sentAt: new Date(),
    type: 'text',
    ...body,
  });
  const send = async (m: InboundChannelMessage) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: m,
    });
    return (res.json() as { replies: { text: string }[] }).replies[0]?.text ?? '';
  };
  const text = (body: string) => send(message({ text: body }));
  const voice = (transcript: string) => {
    nextTranscript = { text: transcript, language: 'en', confidence: 0.9 };
    return send(
      message({
        type: 'audio',
        media: { mimeType: 'audio/ogg; codecs=opus', dataBase64: fixture },
      }),
    );
  };
  /** Scripts the model to draft an order, then reply with filler (replaced by the backend summary). */
  const scriptDraft = (args: object) =>
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: randomUUID().slice(0, 8),
            name: 'create_draft_order',
            arguments: JSON.stringify(args),
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'Draft ready.' }),
    );
  const codeOf = (reply: string) => /CONFIRM (\d{4})/.exec(reply)![1]!;
  const referenceOf = (reply: string) => /ORD-[A-Z0-9]{6}/.exec(reply)![0];
  const paymentFor = (reference: string) =>
    container.db.payment.findFirstOrThrow({ where: { order: { reference } } });
  const buyerPage = (path: string) => app.inject({ method: 'GET', url: path });

  let textRef = '';
  let textCode = '';
  let voiceRef = '';

  beforeAll(async () => {
    const config = parseConfig(apiSchema, testEnv({ VOICE_NOTES_ENABLED: 'true' }));
    container = createContainer(config, createLogger({ name: 'it-mx', level: 'silent' }), {
      paypal,
      chatModel: model,
      speech: new SpeechPipeline({
        stt: { id: 'scripted', transcribe: async () => nextTranscript },
        maxDurationSeconds: 60,
      }),
      channels: new ChannelRegistry(),
    });
    app = await buildApp(container);
    const db = container.db;
    await db.merchant.create({
      data: {
        id: merchantId,
        businessName: 'Experience Crafts',
        ownerName: 'Owner',
        preferredCurrency: 'USD',
        timezone: 'Africa/Kampala',
      },
    });
    await db.merchantOperator.create({
      data: { merchantId, name: 'Owner', channel: 'whatsapp', externalId: operatorChat },
    });
    await db.product.createMany({
      data: [
        {
          merchantId,
          name: 'Handmade Basket',
          sku: `MB-${run}`,
          unitPriceMinor: 1200,
          currency: 'USD',
        },
        {
          merchantId,
          name: 'Barkcloth Wallet',
          sku: `MW-${run}`,
          unitPriceMinor: 1800,
          currency: 'USD',
        },
      ],
    });
    await db.customer.createMany({
      data: [
        { merchantId, name: 'Sarah Thompson', country: 'US' },
        { merchantId, name: 'James Carter', country: 'GB' },
      ],
    });
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await container.close();
  });

  it('tags text and voice orders by input mode, and both reach PAID', async () => {
    scriptDraft({
      customer: { name: 'Sarah' },
      items: [{ name: 'handmade baskets', quantity: 10, unit_price: 12 }],
      shipping: 20,
    });
    const textDraft = await text(
      'Create an order for Sarah for 10 handmade baskets at $12 each and add $20 shipping.',
    );
    textRef = referenceOf(textDraft);
    textCode = codeOf(textDraft);
    expect(await text(`CONFIRM ${textCode}`)).toContain('Payment request created');

    scriptDraft({
      customer: { name: 'James' },
      items: [{ name: 'barkcloth wallets', quantity: 2 }],
    });
    const voiceDraft = await voice('Create an order for James for two barkcloth wallets.');
    voiceRef = referenceOf(voiceDraft);
    expect(voiceDraft).toContain('2 × Barkcloth Wallet @ $18.00 — $36.00');
    await text(`CONFIRM ${codeOf(voiceDraft)}`);

    for (const ref of [textRef, voiceRef]) {
      const page = await buyerPage(
        `/api/paypal/return?token=${(await paymentFor(ref)).externalId}`,
      );
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Payment successful');
      expect(page.body).toContain(`<dd>${ref}</dd>`);
    }

    const orders = await container.db.order.findMany({ where: { merchantId } });
    expect(orders.find((o) => o.reference === textRef)).toMatchObject({
      status: 'PAID',
      inputMode: 'TEXT',
    });
    expect(orders.find((o) => o.reference === voiceRef)).toMatchObject({
      status: 'PAID',
      inputMode: 'VOICE',
    });
  });

  it('answers sales questions from trusted aggregates: products, customers, voice vs text', async () => {
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const summary = await container.analytics.salesSummary(merchant, 'all_time');
    expect(summary.revenue.map((r) => r.formatted)).toEqual(['$176.00']);
    expect(summary.paidOrders).toBe(2);
    expect(summary.averageOrderValue.map((a) => a.formatted)).toEqual(['$88.00']);
    expect(summary.topProducts.map((p) => [p.name, p.formatted])).toEqual([
      ['Handmade Basket', '$120.00'],
      ['Barkcloth Wallet', '$36.00'],
    ]);
    expect(summary.topCustomers.map((c) => [c.name, c.formatted])).toEqual([
      ['Sarah Thompson', '$140.00'],
      ['James Carter', '$36.00'],
    ]);
    expect(summary.bySource.map((s) => [s.name, s.formatted])).toEqual([
      ['WhatsApp text', '$140.00'],
      ['WhatsApp voice', '$36.00'],
    ]);

    const [sarah] = await container.analytics.customerSummary(merchantId, 'sarah');
    expect(sarah).toMatchObject({
      name: 'Sarah Thompson',
      orders_paid: 1,
      total_paid: ['$140.00'],
    });
    expect(sarah!.last_order?.reference).toBe(textRef);
  });

  it('filters orders by status, input mode and customer with a database count', async () => {
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const voiceOrders = await container.orders.find(merchant, { inputMode: 'VOICE' });
    expect(voiceOrders.count).toBe(1);
    expect(voiceOrders.orders[0]!.reference).toBe(voiceRef);
    const jamesPaid = await container.orders.find(merchant, {
      customer: 'james',
      status: 'PAID',
      period: 'today',
    });
    expect(jamesPaid).toMatchObject({ count: 1, total: ['$36.00'], period: 'today' });
    const unpaid = await container.orders.find(merchant, { status: 'AWAITING_PAYMENT' });
    expect(unpaid.count).toBe(0);
  });

  it('serves per-customer statistics for the Customers grid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/customers/stats',
      headers: dashboard,
    });
    const rows = res.json() as {
      name: string;
      orders: number;
      revenueMinor: number;
      lastOrderAt: string | null;
    }[];
    expect(rows.find((r) => r.name === 'Sarah Thompson')).toMatchObject({
      orders: 1,
      revenueMinor: 14_000,
    });
    expect(rows.find((r) => r.name === 'James Carter')).toMatchObject({
      orders: 1,
      revenueMinor: 3_600,
    });
  });

  it('answers a repeated CONFIRM with the existing request, never a second PayPal order', async () => {
    const created = paypal.created.length;
    const reply = await text(`CONFIRM ${textCode}`);
    expect(reply).toContain('That payment request was already created');
    expect(reply).toContain(`Order: ${textRef}`);
    expect(reply).toContain('Status: Paid ✅');
    expect(paypal.created.length).toBe(created);
  });

  it('discards the draft when the merchant replies CANCEL', async () => {
    scriptDraft({ customer: { name: 'Sarah' }, items: [{ name: 'baskets', quantity: 3 }] });
    const ref = referenceOf(await text('Create an order for Sarah for 3 baskets.'));
    expect(await text('CANCEL')).toBe(
      `👍 Discarded. Draft ${ref} was cancelled and nothing was sent.`,
    );
    const order = await container.db.order.findUniqueOrThrow({ where: { reference: ref } });
    expect(order.status).toBe('CANCELLED');
    expect(
      await container.db.auditEvent.count({
        where: { merchantId, type: 'order.discarded', entityId: order.id },
      }),
    ).toBe(1);
  });

  it('keeps the order as an uncharged draft when PayPal is unavailable', async () => {
    scriptDraft({ customer: { name: 'James' }, items: [{ name: 'wallet', quantity: 1 }] });
    const draft = await text('Create an order for James for 1 wallet.');
    paypal.failNextCreate = new ProviderError('paypal', 'HTTP 503 Service Unavailable');
    const reply = await text(`CONFIRM ${codeOf(draft)}`);
    expect(reply).toContain(
      "I couldn't create the payment request right now. Your order has not been charged.",
    );
    expect(reply).not.toContain('503');
    const order = await container.db.order.findUniqueOrThrow({
      where: { reference: referenceOf(draft) },
    });
    expect(order.status).toBe('DRAFT');
  });

  it('shows a clear cancel page that leaves the order awaiting payment', async () => {
    scriptDraft({ customer: { name: 'Sarah' }, items: [{ name: 'basket', quantity: 1 }] });
    const draft = await text('Create an order for Sarah for 1 basket.');
    await text(`CONFIRM ${codeOf(draft)}`);
    const payment = await paymentFor(referenceOf(draft));

    const page = await buyerPage(`/api/paypal/cancel?token=${payment.externalId}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Payment not completed');
    expect(page.body).toContain(`Order ${referenceOf(draft)} is still awaiting payment.`);
    expect(page.body).toContain('Return to PayPal');
    const after = await container.db.order.findUniqueOrThrow({
      where: { reference: referenceOf(draft) },
    });
    expect(after.status).toBe('AWAITING_PAYMENT');
    expect((await paymentFor(referenceOf(draft))).status).toBe('CREATED');

    const paid = await buyerPage(
      `/api/paypal/cancel?token=${(await paymentFor(textRef)).externalId}`,
    );
    expect(paid.body).toContain('Already paid');
    const unknown = await buyerPage('/api/paypal/cancel');
    expect(unknown.body).toContain('No money was taken.');
    expect((await buyerPage('/api/paypal/return?token=NOPE')).statusCode).toBe(404);
  });

  it('never prices a near-miss product from voice without confirmation (text only warns)', async () => {
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const command = {
      customer: { name: 'Sarah Thompson' },
      items: [{ name: 'buckets', quantity: 10, unit_price: 12 }],
    };
    const fromVoice = container.orders.createDraft({
      merchant,
      command,
      source: 'whatsapp',
      inputMode: 'VOICE',
    });
    await expect(fromVoice).rejects.toThrow(ValidationError);
    await expect(fromVoice).rejects.toThrow(
      "'buckets' isn't in the catalog. Did you mean Handmade Basket?",
    );

    const typed = await container.orders.createDraft({
      merchant,
      command,
      source: 'whatsapp',
      inputMode: 'TEXT',
    });
    expect(typed.warnings).toContain(
      "'buckets' isn't in your catalog (closest: Handmade Basket) — priced as stated.",
    );
  });
});
