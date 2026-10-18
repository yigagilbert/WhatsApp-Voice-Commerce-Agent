import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@vca/shared';
import { createGatewayServer } from './gateway-server';
import type { WhatsAppTransport } from './whatsapp-adapter';

const TOKEN = 'internal-token-1234567890';

describe('WhatsApp outbound gateway', () => {
  const sent: { chatId: string; text: string; image?: string }[] = [];
  let ready = true;
  let reconnects = 0;
  let logouts = 0;
  const transport: WhatsAppTransport = {
    start: async () => undefined,
    stop: async () => undefined,
    onMessage: () => undefined,
    onCall: () => undefined,
    isReady: () => ready,
    sendText: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    sendImage: async (chatId, image, caption) => {
      sent.push({ chatId, text: caption, image: image.mimeType });
    },
    connection: () => ({
      state: 'qr',
      qr: '2@pairing-code',
      qrUpdatedAt: '2026-10-17T10:00:00.000Z',
      stateChangedAt: '2026-10-17T10:00:00.000Z',
      account: null,
      lastDisconnectReason: null,
    }),
    reconnect: async () => {
      reconnects++;
    },
    logout: async () => {
      logouts++;
    },
    resolvePhone: async () => null,
    botId: () => null,
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

  it('sends images (charts) with the text as caption', async () => {
    const image = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', filename: 'chart.png' };
    expect((await post({ ...message, text: 'Revenue', media: image }, TOKEN)).status).toBe(202);
    expect(sent.at(-1)).toEqual({
      chatId: '256700000000@c.us',
      text: 'Revenue',
      image: 'image/png',
    });
    expect(
      (await post({ ...message, media: { ...image, mimeType: 'text/html' } }, TOKEN)).status,
    ).toBe(400);
  });

  it('exposes the connection (with QR) only with the internal token', async () => {
    const anonymous = await fetch(`${base}/internal/session`);
    expect(anonymous.status).toBe(401);
    const res = await fetch(`${base}/internal/session`, { headers: { 'x-internal-token': TOKEN } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ state: 'qr', qr: '2@pairing-code' });
  });

  it('reconnects and logs out only with the internal token', async () => {
    const call = (path: string, token?: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: token ? { 'x-internal-token': token } : {},
      });
    expect((await call('/internal/session/logout')).status).toBe(401);
    expect(logouts).toBe(0);
    expect((await call('/internal/session/reconnect', TOKEN)).status).toBe(202);
    expect((await call('/internal/session/logout', TOKEN)).status).toBe(202);
    expect(reconnects).toBe(1);
    expect(logouts).toBe(1);
  });

  it('exposes health with WhatsApp readiness', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toMatchObject({ status: 'ok', whatsapp: 'ready' });
  });
});
