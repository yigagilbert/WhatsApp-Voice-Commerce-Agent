import { describe, expect, it } from 'vitest';
import { runWithContext } from '@vca/shared';
import { HttpWhatsAppSender } from './channel-registry';

describe('HttpWhatsAppSender', () => {
  it('posts outbound messages to the worker gateway with the internal token and trace ID', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ delivered: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const sender = new HttpWhatsAppSender(
      'http://localhost:4100/',
      'internal-token-1234567890',
      fetchImpl,
    );

    await runWithContext({ correlationId: 'trace-1234abcd' }, () =>
      sender.send({
        channel: 'whatsapp',
        externalChatId: '256700000000@c.us',
        text: 'Payment received',
      }),
    );

    expect(calls[0]!.url).toBe('http://localhost:4100/internal/send');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-internal-token']).toBe('internal-token-1234567890');
    expect(headers['x-correlation-id']).toBe('trace-1234abcd');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      channel: 'whatsapp',
      externalChatId: '256700000000@c.us',
      text: 'Payment received',
    });
  });

  it('surfaces gateway failures (e.g. WhatsApp not ready) as provider errors', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const sender = new HttpWhatsAppSender(
      'http://localhost:4100',
      'internal-token-1234567890',
      fetchImpl,
    );
    await expect(
      sender.send({ channel: 'whatsapp', externalChatId: 'x@c.us', text: 'hi' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});
