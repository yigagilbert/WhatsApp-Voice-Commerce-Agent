/**
 * EXTERNAL — real PayPal Sandbox. Small amounts (USD 1.00), sandbox only.
 * Buyer approval needs a human, so capture is covered by `pnpm paypal:smoke capture <id>`.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnvFile, parseConfig, paypalSchema } from '@vca/config';
import { PayPalClient, payPalErrorIssues } from '@vca/paypal';

loadEnvFile();
const config = parseConfig(paypalSchema);
const enabled =
  !!config.PAYPAL_CLIENT_ID && !!config.PAYPAL_CLIENT_SECRET && config.PAYPAL_ENV === 'sandbox';

describe.skipIf(!enabled)('PayPal Sandbox (external)', () => {
  const client = new PayPalClient({
    environment: 'sandbox',
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
  const requestId = `ext-${randomUUID()}`;
  const params = {
    requestId,
    referenceId: 'EXT-TEST',
    customId: requestId.slice(0, 40),
    currency: 'USD',
    items: [{ name: 'External test item', quantity: 2, unitAmount: '0.40' }],
    itemTotal: '0.80',
    shipping: '0.20',
    taxTotal: '0.00',
    total: '1.00',
    returnUrl: 'http://localhost:4000/api/paypal/return',
    cancelUrl: 'http://localhost:4000/api/paypal/cancel',
    brandName: 'Katale AI Tests',
  };
  let orderId = '';

  it('obtains an OAuth token', async () => {
    const result = await client.checkCredentials();
    expect(result.expiresInSeconds).toBeGreaterThan(60);
  });

  it('creates a checkout order with a payer-action URL', async () => {
    const { order, approveUrl } = await client.createCheckoutOrder(params);
    orderId = order.id;
    expect(order.status).toBe('PAYER_ACTION_REQUIRED');
    expect(approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
  });

  it('is idempotent for the same PayPal-Request-Id', async () => {
    const { order } = await client.createCheckoutOrder(params);
    expect(order.id).toBe(orderId);
  });

  it('reads the order back with our references', async () => {
    const order = await client.getOrder(orderId);
    expect(order.purchase_units?.[0]).toMatchObject({
      reference_id: 'EXT-TEST',
      custom_id: params.customId,
    });
  });

  it('refuses to capture before buyer approval', async () => {
    const error = await client
      .captureOrder(orderId, `capture-${requestId}`)
      .catch((e: unknown) => e);
    expect(payPalErrorIssues(error)).toContain('ORDER_NOT_APPROVED');
  });
});
