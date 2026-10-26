/**
 * Order lifecycle, refunds and dashboard figures (Phase 1 hardening), against a real Postgres with
 * simulated PayPal: unpaid-order expiry and cancellation (merchant, customer, system), stock
 * reservations released, payments that race a cancellation, duplicate payments, full/partial
 * refunds and reversals via webhooks (idempotent, never restocked), abandoned webhook claims,
 * net revenue, open carts excluded from counts, and zero-decimal currencies in the dataset.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { generateOrderReference } from '../../packages/commerce/src/services/order.service';
import {
  createLogger,
  type ChannelSender,
  type InboundChannelMessage,
  type OutboundChannelMessage,
} from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { OpsAlerts } from '../../apps/api/src/modules/ops/ops-alerts';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const digits = run.replace(/\D/g, '').padEnd(6, '4').slice(0, 6);
const shop = `lc_shop_${run}`;
const otherShop = `lc_other_${run}`;
const ugxShop = `lc_ugx_${run}`;
const bot = `25670${digits}7@c.us`;
const admin = `25671${digits}7@c.us`;
const jane = `25678${digits}7@c.us`;
const bob = `25678${digits}8@c.us`;
const HOUR = 3_600_000;

const signatureHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tid',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': new Date().toISOString(),
};

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
  to(chatId: string) {
    return this.sent.filter((m) => m.externalChatId === chatId).map((m) => m.text);
  }
}

describe('order lifecycle, refunds and figures (integration)', () => {
  const paypal = new FakePayPal(`LC-${run}`);
  const sender = new RecordingSender();
  /** Operator alerts posted to the (fake) alert webhook. */
  const alertBodies: string[] = [];
  const alerts = new OpsAlerts({
    webhookUrl: 'https://alerts.test/katale',
    logger: createLogger({ name: 'it-lc-alerts', level: 'silent' }),
    fetch: (async (_url: string, init: RequestInit) => {
      alertBodies.push(String(init.body));
      return new Response('ok');
    }) as unknown as typeof fetch,
  });
  let container: Container;
  let app: FastifyInstance;
  let basketId: string;
  let customerId: string;

  const db = () => container.db;
  const dashboard = { authorization: 'Bearer test-dashboard-token-123456', 'x-merchant-id': shop };

  const say = async (from: string, text: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: {
        channel: 'whatsapp',
        externalMessageId: randomUUID(),
        externalChatId: from,
        senderId: from,
        sentAt: new Date(),
        type: 'text',
        text,
        recipientId: bot,
      } satisfies Partial<InboundChannelMessage>,
    });
    const body = res.json() as { replies?: { text: string }[] };
    if (!body.replies) throw new Error(`agent message failed: ${res.body}`);
    return body.replies.map((r) => r.text).join('\n');
  };

  const webhook = (
    eventType: string,
    resource: Record<string, unknown>,
    id: string = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: { id: `WH-${id}`, event_type: eventType, resource },
    });

  /** A merchant order sent for payment: DRAFT → createCheckout → AWAITING_PAYMENT. */
  const awaitingOrder = async (quantity = 2, merchantId = shop) => {
    const order = await db().order.create({
      data: {
        reference: generateOrderReference(),
        merchantId,
        customerId,
        status: 'DRAFT',
        currency: 'USD',
        subtotalMinor: 1200 * quantity,
        totalMinor: 1200 * quantity,
        source: 'whatsapp',
        items: {
          create: [
            {
              productId: basketId,
              description: 'Handmade Basket',
              quantity,
              unitPriceMinor: 1200,
              lineTotalMinor: 1200 * quantity,
            },
          ],
        },
      },
    });
    const full = await container.orders.getByReference(merchantId, order.reference);
    const payment = await container.payments.createCheckout(full, `lc-${randomUUID()}`);
    return { order: await db().order.findUniqueOrThrow({ where: { id: order.id } }), payment };
  };
  const paidOrder = async (quantity = 1) => {
    const { order, payment } = await awaitingOrder(quantity);
    expect(await container.payments.captureApproved(payment.externalId!)).toBe('completed');
    return { order, payment: await db().payment.findUniqueOrThrow({ where: { id: payment.id } }) };
  };
  const basketStock = async () =>
    (await db().product.findUniqueOrThrow({ where: { id: basketId } })).stockQuantity;
  const orderOf = (id: string) => db().order.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    container = createContainer(
      parseConfig(
        apiSchema,
        testEnv({
          CUSTOMER_COMMERCE_ENABLED: 'true',
          CUSTOMER_MESSAGES_PER_MINUTE: '1000',
          UNPAID_ORDER_EXPIRY_HOURS: '72',
        }),
      ),
      createLogger({ name: 'it-lc', level: 'silent' }),
      { paypal, chatModel: new ScriptedChatModel([]), speech: null, channels, alerts },
    );
    app = await buildApp(container);
    for (const [id, name, currency] of [
      [shop, 'Lifecycle Shop', 'USD'],
      [otherShop, 'Other Shop', 'USD'],
      [ugxShop, 'Kampala UGX Shop', 'UGX'],
    ] as const)
      await db().merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: currency },
      });
    await db().merchantOperator.create({
      data: { merchantId: shop, name: 'Owner', channel: 'whatsapp', externalId: admin },
    });
    const account = await container.whatsappAccounts.connect(shop, bot);
    await container.whatsappAccounts.update(
      shop,
      account.id,
      { customerCommerceEnabled: true, deliveryEnabled: false, pickupEnabled: true },
      { customerCommerceAvailable: true },
    );
    basketId = (
      await db().product.create({
        data: {
          merchantId: shop,
          name: 'Handmade Basket',
          sku: `LC-BASKET-${run}`,
          unitPriceMinor: 1200,
          currency: 'USD',
          stockQuantity: 100,
          reorderLevel: 1,
        },
      })
    ).id;
    customerId = (
      await db().customer.create({ data: { merchantId: shop, name: 'Sarah Lifecycle' } })
    ).id;
  });

  afterAll(async () => {
    await db().order.deleteMany({ where: { merchantId: { in: [shop, otherShop, ugxShop] } } });
    await db().merchant.deleteMany({ where: { id: { in: [shop, otherShop, ugxShop] } } });
    await app.close();
    await container.close();
  });

  describe('expiry of unpaid orders', () => {
    it('gives an order sent for payment a due time', async () => {
      const before = Date.now();
      const { order } = await awaitingOrder();
      expect(order.status).toBe('AWAITING_PAYMENT');
      const due = order.paymentDueAt!.getTime();
      expect(due).toBeGreaterThanOrEqual(before + 72 * HOUR - 1000);
      expect(due).toBeLessThanOrEqual(Date.now() + 72 * HOUR + 1000);
    });

    it('cancels overdue orders once, releases their reservation and tells the admins', async () => {
      const { order, payment } = await awaitingOrder(3);
      const available = () => container.shopOrders.available(basketId);
      const reserved = await available();
      await db().order.update({
        where: { id: order.id },
        data: { paymentDueAt: new Date(Date.now() - 1000) },
      });
      const expired = await container.orderLifecycle.expireDue(72);
      expect(expired).toContain(order.reference);
      const after = await orderOf(order.id);
      expect(after).toMatchObject({ status: 'CANCELLED', cancelReason: 'PAYMENT_EXPIRED' });
      expect((await db().payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        'CANCELLED',
      );
      expect(await available()).toBe(reserved + 3);
      expect(
        sender
          .to(admin)
          .some((t) => t.includes(`${order.reference}`) && t.includes('not paid in time')),
      ).toBe(true);

      // A second pass (or a concurrent one) does nothing more.
      expect(await container.orderLifecycle.expireDue(72)).not.toContain(order.reference);
      const events = await db().auditEvent.count({
        where: { type: 'order.expired', entityId: order.id },
      });
      expect(events).toBe(1);
    });

    it('never cancels an order the buyer has just paid: it is captured instead', async () => {
      const { order, payment } = await awaitingOrder();
      paypal.orderStatus.set(payment.externalId!, 'APPROVED');
      await db().order.update({
        where: { id: order.id },
        data: { paymentDueAt: new Date(Date.now() - 1000) },
      });
      expect(await container.orderLifecycle.expireDue(72)).not.toContain(order.reference);
      expect((await orderOf(order.id)).status).toBe('PAID');
    });

    it('gives orders created before due times a full window instead of cancelling them', async () => {
      const { order } = await awaitingOrder();
      await db().order.update({ where: { id: order.id }, data: { paymentDueAt: null } });
      await container.orderLifecycle.expireDue(72);
      const after = await orderOf(order.id);
      expect(after.status).toBe('AWAITING_PAYMENT');
      expect(after.paymentDueAt!.getTime()).toBeGreaterThan(Date.now() + 71 * HOUR);
    });

    it('does nothing when expiry is off', async () => {
      expect(await container.orderLifecycle.expireDue(0)).toEqual([]);
    });

    it('runs concurrent cancellations of one order exactly once', async () => {
      const { order } = await awaitingOrder();
      await db().order.update({
        where: { id: order.id },
        data: { paymentDueAt: new Date(Date.now() - 1000) },
      });
      const results = await Promise.all([
        container.orderLifecycle.cancel({
          merchantId: shop,
          reference: order.reference,
          by: 'MERCHANT',
        }),
        container.orderLifecycle.cancel({
          merchantId: shop,
          reference: order.reference,
          by: 'MERCHANT',
        }),
        container.orderLifecycle.expireDue(72),
      ]);
      const cancelled = results
        .slice(0, 2)
        .filter((r) => r && !Array.isArray(r) && r.status === 'cancelled').length;
      const expired = (results[2] as string[]).includes(order.reference) ? 1 : 0;
      expect(cancelled + expired).toBe(1);
      expect(
        await db().auditEvent.count({
          where: { entityId: order.id, type: { in: ['order.cancelled', 'order.expired'] } },
        }),
      ).toBe(1);
    });
  });

  describe('merchant cancellation (dashboard)', () => {
    it('cancels an unpaid order and is idempotent', async () => {
      const { order } = await awaitingOrder();
      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.reference}/cancel`,
        headers: dashboard,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'cancelled' });
      expect(await orderOf(order.id)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'MERCHANT',
      });
      const again = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.reference}/cancel`,
        headers: dashboard,
        payload: {},
      });
      expect(again.json()).toMatchObject({ status: 'already_cancelled' });
    });

    it('refuses paid orders, unknown orders and other merchants’ orders', async () => {
      const { order } = await paidOrder();
      const paid = await app.inject({
        method: 'POST',
        url: `/api/orders/${order.reference}/cancel`,
        headers: dashboard,
        payload: {},
      });
      expect(paid.statusCode).toBe(409);
      expect((await orderOf(order.id)).status).toBe('PAID');

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/orders/ORD-NOPE00/cancel',
        headers: dashboard,
        payload: {},
      });
      expect(unknown.statusCode).toBe(404);

      const { order: mine } = await awaitingOrder();
      const foreign = await app.inject({
        method: 'POST',
        url: `/api/orders/${mine.reference}/cancel`,
        headers: { ...dashboard, 'x-merchant-id': otherShop },
        payload: {},
      });
      expect(foreign.statusCode).toBe(404);
      expect((await orderOf(mine.id)).status).toBe('AWAITING_PAYMENT');
    });

    it('requires the dashboard token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orders/ORD-ABCDEF/cancel',
        headers: { 'x-internal-token': 'test-internal-token-123456' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('customer cancellation (WhatsApp)', () => {
    let reference: string;

    it('lets a customer cancel their own unpaid order', async () => {
      await say(jane, 'hi');
      await say(jane, '1');
      await say(jane, 'add 2 of 1');
      await say(jane, 'checkout');
      await say(jane, 'Jane Doe');
      const placed = await say(jane, 'ORDER');
      expect(placed).toContain('paypal.com');
      const order = await db().order.findFirstOrThrow({
        where: { merchantId: shop, customer: { whatsappId: jane }, status: 'AWAITING_PAYMENT' },
      });
      reference = order.reference;
      expect(order.paymentDueAt).not.toBeNull();
      expect(await say(jane, 'orders')).toContain('cancel ORD-');

      const reply = await say(jane, `cancel ${reference.toLowerCase()}`);
      expect(reply).toContain(`Order ${reference} is cancelled`);
      expect(await orderOf(order.id)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'CUSTOMER',
      });
      expect(sender.to(admin).some((t) => t.includes(`cancelled order ${reference}`))).toBe(true);
      expect(await say(jane, `cancel ${reference}`)).toContain('already cancelled');
    });

    it("can't cancel someone else's order", async () => {
      await say(bob, 'hi');
      const reply = await say(bob, `cancel ${reference}`);
      expect(reply).toContain("couldn't find order");
    });

    it('frees a customer who hit the unpaid-order limit', async () => {
      const janeId = (
        await db().customer.findFirstOrThrow({ where: { merchantId: shop, whatsappId: jane } })
      ).id;
      // Start from no open cart: the limit applies when a new cart would be opened.
      await db().order.updateMany({
        where: { customerId: janeId, status: 'DRAFT', customerConfirmedAt: null },
        data: { status: 'CANCELLED' },
      });
      const refs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const o = await db().order.create({
          data: {
            reference: generateOrderReference(),
            merchantId: shop,
            customerId: janeId,
            status: 'AWAITING_PAYMENT',
            placedBy: 'CUSTOMER',
            customerConfirmedAt: new Date(),
            currency: 'USD',
            subtotalMinor: 1200,
            totalMinor: 1200,
            source: 'whatsapp',
            paymentDueAt: new Date(Date.now() + HOUR),
          },
        });
        refs.push(o.reference);
      }
      await say(jane, '1');
      expect(await say(jane, 'add 1 of 1')).toContain('You have 3 unpaid orders');
      expect(await say(jane, `cancel ${refs[0]}`)).toContain('is cancelled');
      await say(jane, '1');
      expect(await say(jane, 'add 1 of 1')).toContain('✅ Added');
    });
  });

  describe('payments that race a cancellation', () => {
    it('reinstates a cancelled order when its capture completes late, deducting stock once', async () => {
      const { order, payment } = await awaitingOrder(2);
      await container.orderLifecycle.cancel({
        merchantId: shop,
        reference: order.reference,
        by: 'MERCHANT',
      });
      const stock = await basketStock();
      const res = await webhook('PAYMENT.CAPTURE.COMPLETED', {
        id: `CAP-${payment.externalId}`,
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '24.00' },
        supplementary_data: { related_ids: { order_id: payment.externalId } },
      });
      expect(res.json()).toMatchObject({ outcome: 'processed' });
      expect(await orderOf(order.id)).toMatchObject({ status: 'PAID', cancelReason: null });
      expect((await db().payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        'COMPLETED',
      );
      expect(await basketStock()).toBe(stock! - 2);
      expect(sender.to(admin).some((t) => t.includes('had been cancelled'))).toBe(true);
    });

    it('records a second payment through a superseded link and asks for a refund', async () => {
      const { order, payment } = await paidOrder(1);
      const stock = await basketStock();
      // An older link for the same order, cancelled when a newer one replaced it.
      const old = await db().payment.create({
        data: {
          merchantId: shop,
          orderId: order.id,
          provider: 'PAYPAL',
          kind: 'CHECKOUT_ORDER',
          status: 'CANCELLED',
          amountMinor: payment.amountMinor,
          currency: 'USD',
          idempotencyKey: `lc-old-${randomUUID()}`,
          externalId: `LC-OLD-${run}`,
        },
      });
      expect(await container.payments.markCompleted(old.id, 'CAP-OLD')).toBe(true);
      expect((await orderOf(order.id)).status).toBe('PAID');
      expect(await basketStock()).toBe(stock);
      expect(sender.to(admin).some((t) => t.includes('Second payment received'))).toBe(true);
      expect(await container.payments.markCompleted(old.id, 'CAP-OLD')).toBe(false);
    });

    it('flags a captured amount that differs from the order', async () => {
      const { payment } = await awaitingOrder(1);
      await container.payments.markCompleted(payment.id, 'CAP-X', {
        value: '1.00',
        currency: 'USD',
      });
      expect(
        await db().auditEvent.count({
          where: { type: 'payment.amount_mismatch', entityId: payment.id },
        }),
      ).toBe(1);
    });

    it('shows a buyer who returns from a cancelled order that nothing was taken', async () => {
      const { order, payment } = await awaitingOrder();
      await container.orderLifecycle.cancel({
        merchantId: shop,
        reference: order.reference,
        by: 'MERCHANT',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/paypal/return?token=${payment.externalId}`,
      });
      expect(res.body).toContain('Order cancelled');
      expect(paypal.captures).not.toContain(payment.externalId);
    });
  });

  describe('refunds and reversals', () => {
    const refundEvent = (externalId: string, refundId: string, eventId?: string) =>
      webhook(
        'PAYMENT.CAPTURE.REFUNDED',
        {
          id: refundId,
          status: 'COMPLETED',
          links: [
            {
              rel: 'up',
              href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${externalId}`,
            },
          ],
        },
        eventId,
      );

    it('records a partial refund once, keeps the order paid and never restocks', async () => {
      const { order, payment } = await paidOrder(2);
      const stock = await basketStock();
      paypal.refunds.set(payment.externalId!, [
        { id: `RF1-${run}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
      ]);
      const res = await refundEvent(payment.externalId!, `RF1-${run}`);
      expect(res.json()).toMatchObject({ outcome: 'processed' });
      // Redelivery and a second event for the same refund change nothing.
      await refundEvent(payment.externalId!, `RF1-${run}`);
      await container.refunds.sync(
        await db().payment.findUniqueOrThrow({ where: { id: payment.id } }),
      );

      const p = await db().payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(p).toMatchObject({ status: 'COMPLETED', refundedMinor: 500 });
      expect(await orderOf(order.id)).toMatchObject({ status: 'PAID', refundedMinor: 500 });
      expect(await db().refund.count({ where: { paymentId: payment.id } })).toBe(1);
      expect(await basketStock()).toBe(stock);
      expect(
        sender.to(admin).filter((t) => t.includes('Partial refund') && t.includes(order.reference)),
      ).toHaveLength(1);
    });

    it('completes a full refund across several refunds and tells the admins not to ship', async () => {
      const { order, payment } = await paidOrder(1);
      paypal.refunds.set(payment.externalId!, [
        { id: `RF2a-${run}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '2.00' } },
        {
          id: `RF2b-${run}`,
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '10.00' },
        },
      ]);
      await Promise.all([
        refundEvent(payment.externalId!, `RF2a-${run}`),
        refundEvent(payment.externalId!, `RF2b-${run}`),
      ]);
      expect(await db().payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
        status: 'REFUNDED',
        refundedMinor: 1200,
      });
      expect(await orderOf(order.id)).toMatchObject({ status: 'REFUNDED', refundedMinor: 1200 });
      expect(
        sender.to(admin).some((t) => t.includes('Order refunded') && t.includes('Do not ship')),
      ).toBe(true);
    });

    it('ignores pending refunds until they complete', async () => {
      const { payment } = await paidOrder(1);
      paypal.refunds.set(payment.externalId!, [
        { id: `RF3-${run}`, status: 'PENDING', amount: { currency_code: 'USD', value: '12.00' } },
      ]);
      await refundEvent(payment.externalId!, `RF3-${run}`);
      expect(
        (await db().payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedMinor,
      ).toBe(0);
      paypal.refunds.set(payment.externalId!, [
        { id: `RF3-${run}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '12.00' } },
      ]);
      await refundEvent(payment.externalId!, `RF3-${run}`);
      expect((await db().payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        'REFUNDED',
      );
    });

    it('treats a reversal as a full refund and mentions a shipped order', async () => {
      const { order, payment } = await paidOrder(1);
      await db().order.update({ where: { id: order.id }, data: { fulfillmentStatus: 'SHIPPED' } });
      paypal.reversed.add(payment.externalId!);
      await webhook('PAYMENT.CAPTURE.REVERSED', {
        id: `CAP-${payment.externalId}`,
        status: 'REVERSED',
        supplementary_data: { related_ids: { order_id: payment.externalId } },
      });
      expect(await orderOf(order.id)).toMatchObject({ status: 'REFUNDED', refundedMinor: 1200 });
      expect(
        sender.to(admin).some((t) => t.includes(order.reference) && t.includes('already shipped')),
      ).toBe(true);
    });

    it('reports revenue net of refunds', async () => {
      const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
      const summary = await container.analytics.salesSummary(merchant, 'all_time');
      const payments = await db().payment.findMany({
        where: { merchantId: shop, status: 'COMPLETED' },
      });
      const expected = payments.reduce((s, p) => s + p.amountMinor - p.refundedMinor, 0);
      expect(summary.revenue.find((r) => r.currency === 'USD')?.amountMinor).toBe(expected);
    });

    it('refreshes a payment from PayPal on request (payment review)', async () => {
      const { payment } = await paidOrder(1);
      paypal.refunds.set(payment.externalId!, [
        { id: `RF4-${run}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.00' } },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/api/payments/${payment.id}/refresh`,
        headers: dashboard,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ refundedMinor: 300, status: 'COMPLETED' });
      expect(res.json().refunds).toHaveLength(1);
    });
  });

  describe('operator alerts', () => {
    it('alerts when a webhook can’t be processed, and PayPal gets a retryable error', async () => {
      const { payment } = await paidOrder(1);
      // PayPal can't be reached for the canonical re-read.
      paypal.expired.add(payment.externalId!);
      const res = await webhook('PAYMENT.CAPTURE.REFUNDED', {
        id: `RF-ERR-${run}`,
        supplementary_data: { related_ids: { capture_id: `CAP-${payment.externalId}` } },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(alertBodies.some((b) => b.startsWith('PayPal webhook failed'))).toBe(true);
      expect(alertBodies.join('\n')).not.toContain('Sarah Lifecycle');
      paypal.expired.delete(payment.externalId!);
    });
  });

  describe('webhook claims', () => {
    it('retries an event whose handler never finished (claimed long ago)', async () => {
      const { order, payment } = await awaitingOrder(1);
      const eventId = randomUUID();
      const resource = {
        id: `CAP-${payment.externalId}`,
        status: 'COMPLETED',
        supplementary_data: { related_ids: { order_id: payment.externalId } },
      };
      await db().webhookEvent.create({
        data: {
          provider: 'PAYPAL',
          eventId: `WH-${eventId}`,
          eventType: 'PAYMENT.CAPTURE.COMPLETED',
          payload: {},
          status: 'RECEIVED',
          claimedAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      const res = await webhook('PAYMENT.CAPTURE.COMPLETED', resource, eventId);
      expect(res.json()).toMatchObject({ outcome: 'processed' });
      expect((await orderOf(order.id)).status).toBe('PAID');
    });

    it('leaves an event that is being handled right now to its handler', async () => {
      const eventId = randomUUID();
      await db().webhookEvent.create({
        data: {
          provider: 'PAYPAL',
          eventId: `WH-${eventId}`,
          eventType: 'PAYMENT.CAPTURE.COMPLETED',
          payload: {},
          status: 'RECEIVED',
        },
      });
      const res = await webhook('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-NONE' }, eventId);
      expect(res.json()).toMatchObject({ outcome: 'duplicate' });
    });
  });

  describe('dashboard figures', () => {
    it('does not count open customer carts as orders', async () => {
      await db().order.create({
        data: {
          reference: generateOrderReference(),
          merchantId: shop,
          customerId,
          status: 'DRAFT',
          placedBy: 'CUSTOMER',
          currency: 'USD',
          subtotalMinor: 100,
          totalMinor: 100,
          source: 'whatsapp',
        },
      });
      const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
      const summary = await container.analytics.dashboardSummary(merchant);
      const orders = await db().order.count({
        where: {
          merchantId: shop,
          NOT: { placedBy: 'CUSTOMER', status: 'DRAFT', customerConfirmedAt: null },
        },
      });
      expect(summary.counts.orders).toBe(orders);
      const dataset = await container.analytics.dataset(merchant);
      expect(dataset.orders).toHaveLength(orders);
    });

    it('keeps zero-decimal currencies (UGX) whole in the analytics dataset', async () => {
      const ugxCustomer = await db().customer.create({
        data: { merchantId: ugxShop, name: 'Kato' },
      });
      await db().order.create({
        data: {
          reference: generateOrderReference(),
          merchantId: ugxShop,
          customerId: ugxCustomer.id,
          status: 'AWAITING_PAYMENT',
          currency: 'UGX',
          subtotalMinor: 50_000,
          totalMinor: 50_000,
          source: 'whatsapp',
        },
      });
      const merchant = await db().merchant.findUniqueOrThrow({ where: { id: ugxShop } });
      const dataset = await container.analytics.dataset(merchant);
      expect(dataset.orders[0]).toMatchObject({ currency: 'UGX', total: 50_000 });
    });
  });
});
