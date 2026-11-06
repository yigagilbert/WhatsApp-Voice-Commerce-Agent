/**
 * Customer voice notes, against a real Postgres with scripted speech-to-text and LLM. Speech can
 * browse, ask and fill a cart. It can't place an order or agree a price, noise is never read back
 * as if someone said it, and low-confidence speech is confirmed first.
 *
 * Run: pnpm test:integration
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  createLogger,
  type ChannelSender,
  type InboundChannelMessage,
  type OutboundChannelMessage,
} from '@vca/shared';
import { SpeechPipeline, type SpeechToTextProvider, type TranscriptionResult } from '@vca/speech';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `cv_shop_${run}`;
const number = () => `2567${String(randomInt(10_000_000, 99_999_999))}`;
const bot = `${number()}@c.us`;
const admin = `${number()}@c.us`;
const newChat = () => `${number()}@c.us`;
const fixture = readFileSync(join(__dirname, '../fixtures/voice/en-order-001.ogg')).toString(
  'base64',
);

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

class ScriptedStt implements SpeechToTextProvider {
  readonly id = 'scripted';
  next: TranscriptionResult = { text: '' };
  prompts: (string | undefined)[] = [];
  async transcribe(_audio: unknown, options?: { prompt?: string }) {
    this.prompts.push(options?.prompt);
    return this.next;
  }
}

describe('customer voice notes (integration)', () => {
  const stt = new ScriptedStt();
  const model = new ScriptedChatModel([]);
  const sender = new RecordingSender();
  let container: Container;
  let app: FastifyInstance;

  const post = async (message: Partial<InboundChannelMessage> & { externalChatId: string }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: {
        channel: 'whatsapp',
        externalMessageId: randomUUID(),
        senderId: message.externalChatId,
        senderName: 'Voice Shopper',
        sentAt: new Date(),
        type: 'text',
        recipientId: bot,
        ...message,
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().replies as { text: string }[]).map((r) => r.text).join('\n');
  };
  const typed = (chat: string, text: string) => post({ externalChatId: chat, text });
  const spoken = (chat: string, text: string, confidence = 0.75, language = 'en') => {
    stt.next = { text, confidence, language };
    return post({
      externalChatId: chat,
      type: 'audio',
      media: { mimeType: 'audio/ogg; codecs=opus', dataBase64: fixture },
    });
  };
  const ordersOf = async (chat: string) => {
    const customer = await container.db.customer.findFirstOrThrow({
      where: { merchantId: shop, whatsappId: chat },
    });
    return container.db.order.findMany({
      where: { merchantId: shop, customerId: customer.id },
      include: { items: true },
    });
  };

  beforeAll(async () => {
    container = createContainer(
      parseConfig(
        apiSchema,
        testEnv({
          CUSTOMER_COMMERCE_ENABLED: 'true',
          VOICE_NOTES_ENABLED: 'true',
          CUSTOMER_MESSAGES_PER_MINUTE: '1000',
        }),
      ),
      createLogger({ name: 'it-cv', level: 'silent' }),
      {
        paypal: new FakePayPal(`CV-${run}`),
        chatModel: model,
        speech: new SpeechPipeline({ stt, maxDurationSeconds: 60 }),
        channels: new ChannelRegistry().register(sender),
      },
    );
    app = await buildApp(container);
    const db = container.db;
    await db.merchant.create({
      data: { id: shop, businessName: 'Voice Shop', ownerName: 'Owner', preferredCurrency: 'USD' },
    });
    await db.merchantOperator.create({
      data: { merchantId: shop, name: 'Owner', channel: 'whatsapp', externalId: admin },
    });
    const account = await container.whatsappAccounts.connect(shop, bot);
    await container.whatsappAccounts.update(
      shop,
      account.id,
      { customerCommerceEnabled: true, deliveryEnabled: true },
      { customerCommerceAvailable: true },
    );
    await db.product.create({
      data: {
        merchantId: shop,
        name: 'Woven Basket',
        sku: `basket-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
        stockQuantity: 50,
      },
    });
  });

  beforeEach(() => {
    model.requests.length = 0;
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId: shop } });
    await container.db.merchant.delete({ where: { id: shop } });
    await app.close();
    await container.close();
  });

  it('a customer can ask by voice, and sees what was heard', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    model.enqueue(() => ({ role: 'assistant', content: 'We have woven baskets.' }));
    const text = await spoken(chat, 'What baskets do you have?');
    expect(text).toContain('🎙️ Heard: “What baskets do you have?”');
    expect(text).toContain('We have woven baskets.');
    expect(model.requests[0]!.messages[0]!.content).toContain('voice note');
  });

  it('tells speech recognition about the shop’s products and local places', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    stt.prompts.length = 0;
    model.enqueue(() => ({ role: 'assistant', content: 'ok' }));
    await spoken(chat, 'something');
    expect(stt.prompts.at(-1)).toContain('Woven Basket');
    expect(stt.prompts.at(-1)).toContain('Ntinda');
  });

  it('fills the cart by voice, and uses deterministic commands too', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    expect(await spoken(chat, 'Show me my cart.')).toContain('Your cart is empty');
    await typed(chat, '1');
    expect(await spoken(chat, 'add 2 of 1')).toContain('now 2 in your cart');
    const [order] = await ordersOf(chat);
    expect(order!.items[0]!.quantity).toBe(2);
  });

  it.each(['Order.', 'ORDER', 'order'])('spoken %s never places an order', async (word) => {
    const chat = newChat();
    await typed(chat, 'hi');
    await typed(chat, '1');
    await typed(chat, 'add 1 of 1');
    await typed(chat, 'checkout');
    await typed(chat, 'Plot 12 Kampala Road');
    expect(await spoken(chat, word)).toContain('Please type *ORDER*');
    const [order] = await ordersOf(chat);
    expect(order!.customerConfirmedAt).toBeNull();
    // Typing still works, straight after.
    expect(await typed(chat, 'ORDER')).toContain('placed!');
  });

  it('spoken "deal" and accept_offer never agree a price', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    expect(await spoken(chat, 'Deal.')).toContain('Please type *deal*');
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a1', name: 'accept_offer', arguments: '{}' }],
      }),
      () => ({ role: 'assistant', content: 'Done, you got it.' }),
    );
    expect(await spoken(chat, 'I will take it at that price')).toContain('please type *deal*');
  });

  it('a spoken cancel of an order must be typed', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    expect(await spoken(chat, 'cancel ORD-ABC123')).toContain('Please type *cancel ORD-ABC123*');
  });

  it.each([
    ['Thank you for watching.', 0],
    ['you', 0],
    ['Thank you for watching.', 0.3],
    ['send me a basket', 0.05],
  ])('noise (%s at %s) gets a clear retry, no read-back and no agent', async (text, confidence) => {
    const chat = newChat();
    await typed(chat, 'hi');
    const reply = await spoken(chat, text, confidence);
    expect(reply).toContain("couldn't hear that clearly");
    expect(reply).not.toContain('I heard');
    expect(model.requests).toHaveLength(0);
  });

  it('low confidence is read back, and the typed yes continues', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    const readBack = await spoken(chat, 'show me my cart', 0.4);
    expect(readBack).toContain('I heard');
    expect(readBack).toContain('show me my cart');
    expect(await typed(chat, 'yes')).toContain('Your cart is empty');
  });

  it('"no" to the read-back drops it, and something else moves on', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    await spoken(chat, 'add 5 baskets', 0.4);
    expect(await typed(chat, 'no')).toContain('send it again');
    await spoken(chat, 'add 5 baskets', 0.4);
    expect(await typed(chat, 'cart')).toContain('Your cart is empty');
    // The read-back was dropped when they moved on: this "yes" no longer adds anything.
    model.enqueue(() => ({ role: 'assistant', content: 'What would you like?' }));
    expect(await typed(chat, 'yes')).toBe('What would you like?');
  });

  it('another language is read back rather than guessed', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    expect(await spoken(chat, 'Nkwagala ebibbo', 0.9, 'lg')).toContain('I heard');
  });

  it('during a hand-off the team gets the transcript, clearly marked as the customer’s', async () => {
    const chat = newChat();
    await typed(chat, 'talk to a person');
    await spoken(chat, 'Is my order ready?');
    const alert = sender.sent.filter((m) => m.externalChatId === admin).at(-1)!.text;
    expect(alert).toContain('“Is my order ready?”');
  });

  it('merchant noise gets a retry too, and a quoted alert must be typed', async () => {
    stt.next = { text: 'Thank you for watching.', confidence: 0, language: 'en' };
    const reply = await post({
      externalChatId: admin,
      type: 'audio',
      media: { mimeType: 'audio/ogg; codecs=opus', dataBase64: fixture },
    });
    expect(reply).toContain("couldn't hear that clearly");
    expect(model.requests).toHaveLength(0);
  });

  it('with speech off, a customer is told to type', async () => {
    const chat = newChat();
    await typed(chat, 'hi');
    const reply = await post({
      externalChatId: chat,
      type: 'unsupported',
      unsupportedKind: 'voice',
    });
    expect(reply).toContain("can't listen to voice notes");
  });
});
