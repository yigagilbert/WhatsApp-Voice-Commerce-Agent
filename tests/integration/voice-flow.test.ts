/**
 * Voice notes through the SAME inbound commerce pipeline as text, against a real Postgres,
 * with scripted speech-to-text and LLM. Proves: voice → draft; duplicates ignored; STT failures
 * create nothing; long/invalid audio rejected; low-confidence read-back; spoken approvals refused.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { ProviderError, createLogger, type InboundChannelMessage } from '@vca/shared';
import {
  SpeechPipeline,
  type SpeechToTextProvider,
  type TranscriptionResult,
} from '../../packages/speech/src';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const merchantId = `voice_merchant_${run}`;
const operatorChat = `1777${run}@c.us`;
const fixture = readFileSync(join(__dirname, '../fixtures/voice/en-order-001.ogg')).toString(
  'base64',
);

/** STT double whose next result (or failure) each test sets. */
class ScriptedStt implements SpeechToTextProvider {
  readonly id = 'scripted-stt';
  calls = 0;
  next: TranscriptionResult | Error = { text: '' };
  async transcribe(): Promise<TranscriptionResult> {
    this.calls++;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

describe('voice commerce (integration)', () => {
  const paypal = new FakePayPal();
  const stt = new ScriptedStt();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;

  const voice = (
    id = randomUUID(),
    base64 = fixture,
    mimeType = 'audio/ogg; codecs=opus',
  ): InboundChannelMessage => ({
    channel: 'whatsapp',
    externalMessageId: id,
    externalChatId: operatorChat,
    senderId: operatorChat,
    sentAt: new Date(),
    type: 'audio',
    media: { mimeType, dataBase64: base64 },
  });
  const text = (body: string): InboundChannelMessage => ({
    channel: 'whatsapp',
    externalMessageId: randomUUID(),
    externalChatId: operatorChat,
    senderId: operatorChat,
    sentAt: new Date(),
    type: 'text',
    text: body,
  });
  const send = async (message: InboundChannelMessage) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: message,
    });
    return res.json() as { status: string; replies: { text: string }[] };
  };
  const counts = async () => ({
    orders: await container.db.order.count({ where: { merchantId } }),
    confirmations: await container.db.actionConfirmation.count({ where: { merchantId } }),
    paypal: paypal.created.length,
  });
  const draftScript = (quantity: number) =>
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: `v-${quantity}-${randomUUID().slice(0, 4)}`,
            name: 'create_draft_order',
            arguments: JSON.stringify({
              customer: { name: 'Sarah' },
              items: [{ name: 'handmade baskets', quantity, unit_price: 12 }],
              shipping: 20,
            }),
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'Draft ready.' }),
    );

  beforeAll(async () => {
    const config = parseConfig(apiSchema, testEnv({ VOICE_NOTES_ENABLED: 'true' }));
    container = createContainer(config, createLogger({ name: 'it-voice', level: 'silent' }), {
      paypal,
      chatModel: model,
      speech: new SpeechPipeline({ stt, maxDurationSeconds: 60 }),
      channels: new ChannelRegistry(),
    });
    app = await buildApp(container);
    const db = container.db;
    await db.merchant.create({
      data: {
        id: merchantId,
        businessName: 'Voice Crafts',
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
        sku: `VB-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
        stockQuantity: 500,
      },
    });
    await db.customer.create({ data: { merchantId, name: 'Sarah Thompson' } });
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await container.close();
  });

  it('turns an English voice note into the same backend draft as text, and records the transcript', async () => {
    stt.next = {
      text: 'Create an order for Sarah for 10 handmade baskets at $12 each and add $20 shipping.',
      language: 'en',
      confidence: 0.82,
      provider: 'scripted-stt',
    };
    draftScript(10);
    const id = randomUUID();
    const result = await send(voice(id));
    const reply = result.replies[0]!.text;
    expect(reply).toContain('10 × Handmade Basket @ $12.00 — $120.00');
    expect(reply).toContain('*Total — $140.00*');
    expect(reply).toMatch(/CONFIRM \d{4}/);

    const stored = await container.db.message.findFirstOrThrow({
      where: { externalMessageId: id },
    });
    expect(stored).toMatchObject({ type: 'AUDIO', detectedLanguage: 'en' });
    expect(stored.transcription).toContain('10 handmade baskets');
    // The LLM was told the request came from a voice note.
    const systemPrompt = model.requests.at(-2)!.messages[0]!;
    expect('content' in systemPrompt && systemPrompt.content).toContain(
      'transcribed from a voice note',
    );

    const audit = await container.db.auditEvent.findMany({
      where: { merchantId, type: { in: ['speech.transcribed', 'voice.processed'] } },
    });
    expect(audit.map((a) => a.type).sort()).toEqual(['speech.transcribed', 'voice.processed']);
    expect(audit.find((a) => a.type === 'voice.processed')!.data).toMatchObject({
      outcome: 'agent',
      language: 'en',
    });
  });

  it('ignores a redelivered voice note (no second transcription, draft or confirmation)', async () => {
    stt.next = {
      text: 'Create an order for Sarah for 2 handmade baskets.',
      language: 'en',
      confidence: 0.9,
    };
    draftScript(2);
    const id = randomUUID();
    await send(voice(id));
    const before = { ...(await counts()), sttCalls: stt.calls };
    const again = await send(voice(id));
    expect(again.status).toBe('duplicate');
    expect({ ...(await counts()), sttCalls: stt.calls }).toEqual(before);
  });

  it('creates nothing when speech-to-text fails, and tells the merchant politely', async () => {
    const before = await counts();
    stt.next = new ProviderError('stt', 'HTTP 503');
    const result = await send(voice());
    expect(result.replies[0]!.text).toBe(
      "I couldn't understand that voice note. Please try again or send the request as text.",
    );
    expect(await counts()).toEqual(before);
  });

  it('rejects voice notes over 60 seconds before any speech-to-text call', async () => {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    const page = (g: bigint, p: Buffer) => {
      const h = Buffer.alloc(27);
      h.write('OggS', 0, 'latin1');
      h.writeBigInt64LE(g, 6);
      return Buffer.concat([h, p]);
    };
    const longOgg = Buffer.concat([page(0n, head), page(48_000n * 95n, Buffer.alloc(8))]).toString(
      'base64',
    );
    const calls = stt.calls;
    const result = await send(voice(randomUUID(), longOgg));
    expect(result.replies[0]!.text).toContain('too long for now. Please keep it under 60 seconds');
    expect(stt.calls).toBe(calls);
  });

  it('rejects audio that is not a voice note', async () => {
    const result = await send(
      voice(randomUUID(), Buffer.from('not audio').toString('base64'), 'audio/ogg'),
    );
    expect(result.replies[0]!.text).toBe(
      "I couldn't process that audio. Please send a WhatsApp voice note or type your request.",
    );
  });

  it('reads back low-confidence transcripts and only proceeds on a typed YES', async () => {
    const before = await counts();
    stt.next = {
      text: 'Create an order for Sarah for fifteen baskets',
      language: 'en',
      confidence: 0.31,
    };
    const readback = await send(voice());
    expect(readback.replies[0]!.text).toContain('I heard:');
    expect(readback.replies[0]!.text).toContain('"Create an order for Sarah for fifteen baskets"');
    expect(await counts()).toEqual(before); // nothing acted on the unclear transcript

    draftScript(15);
    const yes = await send(text('YES'));
    expect(yes.replies[0]!.text).toContain('15 × Handmade Basket');
    expect((await counts()).orders).toBe(before.orders + 1);
  });

  it('never creates a customer from a misheard voice name, and suggests the closest match', async () => {
    const customersBefore = await container.db.customer.count({ where: { merchantId } });
    stt.next = { text: 'Create an order for ssaala for two baskets', language: 'en' };
    const captured: string[] = [];
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'misheard',
            name: 'create_draft_order',
            arguments: JSON.stringify({
              customer: { name: 'ssaala' },
              items: [{ name: 'handmade baskets', quantity: 2 }],
            }),
          },
        ],
      }),
      (req) => {
        const last = req.messages.at(-1);
        captured.push(last && 'content' in last ? (last.content ?? '') : '');
        return { role: 'assistant', content: 'Did you mean Sarah Thompson?' };
      },
    );
    const result = await send(voice());
    expect(result.replies[0]!.text).toBe('Did you mean Sarah Thompson?');
    expect(captured[0]).toContain("No customer named 'ssaala'. Did you mean Sarah Thompson?");
    expect(await container.db.customer.count({ where: { merchantId } })).toBe(customersBefore);
  });

  it('reads back a voice note heard in a language other than English (English is supported)', async () => {
    const before = await counts();
    stt.next = { text: 'Nataka vikapu kumi kwa Sarah', language: 'sw', confidence: 0.92 };
    const reply = await send(voice());
    expect(reply.replies[0]!.text).toContain('I heard:');
    expect(await counts()).toEqual(before);
    await send(text('NO'));
  });

  it('normalises Luganda number words before the agent (dollar abiri = 20)', async () => {
    const pipeline = new SpeechPipeline({
      stt: {
        id: 'x',
        transcribe: async () => ({ text: 'Shipping price ya dollar abiri', language: 'lg' }),
      },
      textNormalizers: { lg: (await import('../../packages/speech/src')).normalizeLugandaNumbers },
    });
    const r = await pipeline.process({
      data: Buffer.from(fixture, 'base64'),
      mimeType: 'audio/ogg',
    });
    expect(r.normalizedText).toBe('Shipping price ya dollar 20');
    expect(r.transcript).toBe('Shipping price ya dollar abiri');
  });

  it('never accepts a spoken approval for a payment request', async () => {
    stt.next = {
      text: 'Create an order for Sarah for 3 handmade baskets.',
      language: 'en',
      confidence: 0.9,
    };
    draftScript(3);
    const draft = await send(voice());
    const code = /CONFIRM (\d{4})/.exec(draft.replies[0]!.text)![1]!;

    stt.next = { text: `Confirm ${code}.`, language: 'en', confidence: 0.95 };
    const spoken = await send(voice());
    expect(spoken.replies[0]!.text).toContain(`type *CONFIRM ${code}*`);
    expect(paypal.created.length).toBe((await counts()).paypal);
    const pending = await container.db.actionConfirmation.count({
      where: { merchantId, status: 'PENDING' },
    });
    expect(pending).toBe(1);

    const typed = await send(text(`CONFIRM ${code}`));
    expect(typed.replies[0]!.text).toContain('Payment request created');
  });
});
