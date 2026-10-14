import { describe, expect, it } from 'vitest';
import { PayPalClient, payPalErrorIssues } from './client';
import { extractCaptureRefs, readWebhookHeaders } from './webhooks';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const body = responses[path];
    if (body === undefined)
      return new Response(JSON.stringify({ name: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const params = {
  requestId: 'conf_1',
  referenceId: 'ORD-ABC123',
  customId: 'pay_1',
  currency: 'USD',
  items: [{ name: 'Handmade Basket', quantity: 50, unitAmount: '12.00' }],
  itemTotal: '600.00',
  shipping: '80.00',
  taxTotal: '0.00',
  total: '680.00',
  returnUrl: 'http://localhost:4000/api/paypal/return',
  cancelUrl: 'http://localhost:4000/api/paypal/cancel',
  brandName: 'Kampala Crafts',
};

describe('PayPalClient', () => {
  it('reports when credentials are missing', async () => {
    const client = new PayPalClient({ environment: 'sandbox' });
    expect(client.configured).toBe(false);
    await expect(client.getOrder('X')).rejects.toThrow(/not configured/);
  });

  it('creates a checkout order with idempotency key, breakdown and approval link; caches the token', async () => {
    const { impl, calls } = fakeFetch({
      '/v1/oauth2/token': { access_token: 'tok', expires_in: 3600 },
      '/v2/checkout/orders': {
        id: 'PP-1',
        status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/checkoutnow?token=PP-1' }],
      },
    });
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 'secret',
      fetch: impl,
    });

    const { order, approveUrl } = await client.createCheckoutOrder(params);
    await client.createCheckoutOrder(params);

    expect(order.id).toBe('PP-1');
    expect(approveUrl).toContain('token=PP-1');
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(1);

    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(create.url.startsWith('https://api-m.sandbox.paypal.com')).toBe(true);
    expect((create.init.headers as Record<string, string>)['paypal-request-id']).toBe('conf_1');
    const body = JSON.parse(String(create.init.body));
    expect(body.purchase_units[0].amount).toEqual({
      currency_code: 'USD',
      value: '680.00',
      breakdown: {
        item_total: { currency_code: 'USD', value: '600.00' },
        shipping: { currency_code: 'USD', value: '80.00' },
        tax_total: { currency_code: 'USD', value: '0.00' },
      },
    });
    expect(body.purchase_units[0].items[0]).toMatchObject({
      quantity: '50',
      unit_amount: { value: '12.00' },
    });
  });

  it('surfaces PayPal errors with debug info', async () => {
    const impl = (async (url: string) =>
      url.endsWith('/v1/oauth2/token')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
        : new Response(
            JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'dbg' }),
            { status: 422 },
          )) as unknown as typeof fetch;
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 's',
      fetch: impl,
    });
    await expect(client.createCheckoutOrder(params)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { debugId: 'dbg' },
    });
  });

  it('reports OAuth failures in their RFC 6749 shape', async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'Client Authentication failed',
        }),
        {
          status: 401,
        },
      )) as unknown as typeof fetch;
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 'bad',
      fetch: impl,
    });
    await expect(client.checkCredentials()).rejects.toThrow(
      'invalid_client: Client Authentication failed',
    );
  });

  it('refreshes a rejected cached token once and resends the same request ID', async () => {
    let tokens = 0;
    const seen: string[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/oauth2/token')) {
        tokens++;
        return new Response(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 3600 }));
      }
      const headers = init.headers as Record<string, string>;
      seen.push(`${headers.authorization}|${headers['paypal-request-id']}`);
      return headers.authorization === 'Bearer tok1'
        ? new Response(JSON.stringify({ name: 'AUTHENTICATION_FAILURE' }), { status: 401 })
        : new Response(JSON.stringify({ id: 'PP-9', status: 'COMPLETED' }));
    }) as unknown as typeof fetch;
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 's',
      fetch: impl,
    });
    await client.checkCredentials(); // caches tok1
    const order = await client.captureOrder('PP-9', 'capture-1');
    expect(order.id).toBe('PP-9');
    expect(seen).toEqual(['Bearer tok1|capture-1', 'Bearer tok2|capture-1']);
  });

  it('exposes PayPal issue codes for idempotency handling', async () => {
    const impl = (async (url: string) =>
      url.endsWith('/v1/oauth2/token')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
        : new Response(
            JSON.stringify({
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'ORDER_ALREADY_CAPTURED' }],
            }),
            { status: 422 },
          )) as unknown as typeof fetch;
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 's',
      fetch: impl,
    });
    const error = await client.captureOrder('PP-1', 'k').catch((e: unknown) => e);
    expect(payPalErrorIssues(error)).toEqual(['ORDER_ALREADY_CAPTURED']);
  });

  it('verifies webhooks by splicing the raw body verbatim', async () => {
    const { impl, calls } = fakeFetch({
      '/v1/oauth2/token': { access_token: 'tok', expires_in: 3600 },
      '/v1/notifications/verify-webhook-signature': { verification_status: 'SUCCESS' },
    });
    const client = new PayPalClient({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 's',
      fetch: impl,
    });
    const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","amount":1.50}';
    const ok = await client.verifyWebhookSignature({
      headers: {
        authAlgo: 'SHA256withRSA',
        certUrl: 'https://cert',
        transmissionId: 't',
        transmissionSig: 's',
        transmissionTime: 'now',
      },
      rawBody,
      webhookId: 'WH-ID',
    });
    expect(ok).toBe(true);
    const sent = String(calls.at(-1)!.init.body);
    expect(sent.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);
    expect(JSON.parse(sent).webhook_id).toBe('WH-ID');
  });
});

describe('webhook helpers', () => {
  it('reads transmission headers', () => {
    expect(readWebhookHeaders({ 'paypal-auth-algo': 'a' })).toBeNull();
    expect(
      readWebhookHeaders({
        'paypal-auth-algo': 'a',
        'paypal-cert-url': 'b',
        'paypal-transmission-id': 'c',
        'paypal-transmission-sig': 'd',
        'paypal-transmission-time': 'e',
      }),
    ).toEqual({
      authAlgo: 'a',
      certUrl: 'b',
      transmissionId: 'c',
      transmissionSig: 'd',
      transmissionTime: 'e',
    });
  });

  it('extracts capture references', () => {
    expect(
      extractCaptureRefs({
        id: 'CAP-1',
        custom_id: 'pay_1',
        supplementary_data: { related_ids: { order_id: 'PP-1' } },
      }),
    ).toEqual({ captureId: 'CAP-1', paypalOrderId: 'PP-1', customId: 'pay_1' });
  });
});
