import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { FakePayPal, testEnv } from '../../../tests/support/fakes';
import { buildApp } from './app';
import { createContainer, type Container } from './container';

/** HTTP-level tests that don't need a database: auth, validation, webhook rejection, health. */
describe('API (no database)', () => {
  let app: FastifyInstance;
  let container: Container;
  const paypal = new FakePayPal();

  beforeAll(async () => {
    // Unreachable DB on purpose: these routes must reject before touching it.
    const config = parseConfig(
      apiSchema,
      testEnv({ DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/none' }),
    );
    container = createContainer(config, createLogger({ name: 'test', level: 'silent' }), {
      paypal,
      chatModel: null,
      speech: null,
    });
    app = await buildApp(container);
  });
  afterAll(async () => {
    await app.close();
    await container.close();
  });

  it('serves liveness and echoes the correlation ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-correlation-id': 'corr-12345678' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(res.headers['x-correlation-id']).toBe('corr-12345678');
  });

  it('reports degraded readiness when the database is down', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      checks: { database: 'unavailable' },
      providers: { ai: 'not_configured' },
    });
  });

  it('requires the dashboard token for dashboard routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orders' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: 'Bearer wrong-token-xxxxxxxx' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('authenticates and validates agent messages', async () => {
    const unauth = await app.inject({ method: 'POST', url: '/api/agent/message', payload: {} });
    expect(unauth.statusCode).toBe(401);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: { channel: 'whatsapp', type: 'text' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': 'test-internal-token-123456',
      },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects PayPal webhooks without a valid signature', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      payload: { id: 'WH-1' },
    });
    expect(missing.statusCode).toBe(401);

    paypal.verifyResult = false;
    const forged = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-transmission-id': 'tid',
        'paypal-transmission-sig': 'forged',
        'paypal-transmission-time': new Date().toISOString(),
      },
      payload: { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ error: { message: 'Invalid PayPal webhook signature' } });

    // PayPal answers malformed verification input with 400 → still a 401, not a 502.
    paypal.verifyErrorStatus = 400;
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: {
        'paypal-auth-algo': 'x',
        'paypal-cert-url': 'x',
        'paypal-transmission-id': 'x',
        'paypal-transmission-sig': 'x',
        'paypal-transmission-time': 'x',
      },
      payload: { id: 'WH-2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} },
    });
    expect(malformed.statusCode).toBe(401);
    paypal.verifyErrorStatus = null;
  });
});
