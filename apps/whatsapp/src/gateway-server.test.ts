import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@vca/shared';
import { createGatewayServer } from './gateway-server';
import type { WhatsAppTransport } from './whatsapp-adapter';

const TOKEN = 'internal-token-1234567890';

describe('WhatsApp outbound gateway', () => {
  const sent: { chatId: string; text: string }[] = [];
  let ready = true;
  const transport: WhatsAppTransport = {
    start: async () => undefined,
    stop: async () => undefined,
    onMessage: () => undefined,
    isReady: () => ready,
    sendText: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  };
  const server = createGatewayServer({
    transport,
    internalToken: TOKEN,
    logger: createLogger({ name: 't', level: 'silent' }),
  });
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: unknown, token?: string) =>
    fetch(`${base}/internal/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-internal-token': token } : {}),
      },
      body: JSON.stringify(body),
    });
  const message = {
    channel: 'whatsapp',
    externalChatId: '256700000000@c.us',
    text: '✅ Payment received',
  };

  it('rejects requests without the internal token', async () => {
    expect((await post(message)).status).toBe(401);
    expect((await post(message, 'wrong-token-xxxxxxxxxx')).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('delivers valid messages through the transport', async () => {
    expect((await post(message, TOKEN)).status).toBe(202);
    expect(sent).toEqual([{ chatId: '256700000000@c.us', text: '✅ Payment received' }]);
  });

  it('validates the payload and channel', async () => {
    expect((await post({ ...message, channel: 'web' }, TOKEN)).status).toBe(400);
    expect((await post({ channel: 'whatsapp' }, TOKEN)).status).toBe(400);
  });

  it('reports 503 while WhatsApp is not ready', async () => {
    ready = false;
    expect((await post(message, TOKEN)).status).toBe(503);
    ready = true;
  });

  it('exposes health with WhatsApp readiness', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toMatchObject({ status: 'ok', whatsapp: 'ready' });
  });
});
