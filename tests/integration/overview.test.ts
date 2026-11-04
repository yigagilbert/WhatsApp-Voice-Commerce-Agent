/**
 * The Overview's figures against a real Postgres: every number is checked against a small set of
 * orders whose correct answers are worked out by hand here, including the cases that overstate
 * revenue when handled naively.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `ov_shop_${run}`;
const otherShop = `ov_other_${run}`;
// A Wednesday, 10:00 in Kampala (UTC+3): the week began on Monday 2 Nov, 00:00 Kampala time.
const NOW = new Date('2026-11-04T07:00:00Z');
const DAY = 86_400_000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe('overview figures (integration)', () => {
  let container: Container;
  let app: FastifyInstance;
  let seq = 0;
  const db = () => container.db;

  const sale = async (input: {
    merchantId?: string;
    totalMinor: number;
    currency?: string;
    at: Date;
    orderStatus?: 'PAID' | 'REFUNDED' | 'AWAITING_PAYMENT' | 'CANCELLED';
    paymentStatus?: 'COMPLETED' | 'REFUNDED' | 'CREATED' | 'CANCELLED';
    refundedMinor?: number;
    source?: string;
    inputMode?: 'TEXT' | 'VOICE';
    description?: string;
    shippingMinor?: number;
    extra?: Record<string, unknown>;
  }) => {
    const merchantId = input.merchantId ?? shop;
    const customer = await db().customer.create({ data: { merchantId, name: `C${++seq}` } });
    const currency = input.currency ?? 'USD';
    const shippingMinor = input.shippingMinor ?? 0;
    const refundedMinor = input.refundedMinor ?? 0;
    const paid =
      (input.paymentStatus ?? 'COMPLETED') === 'COMPLETED' || input.paymentStatus === 'REFUNDED';
    const order = await db().order.create({
      data: {
        reference: `OV-${run}-${seq}`,
        merchantId,
        customerId: customer.id,
        status: input.orderStatus ?? 'PAID',
        currency,
        subtotalMinor: input.totalMinor - shippingMinor,
        shippingMinor,
        totalMinor: input.totalMinor,
        refundedMinor,
        source: input.source ?? 'whatsapp',
        inputMode: input.inputMode ?? 'TEXT',
        createdAt: input.at,
        items: {
          create: {
            description: input.description ?? 'Basket',
            quantity: 1,
            unitPriceMinor: input.totalMinor - shippingMinor,
            lineTotalMinor: input.totalMinor - shippingMinor,
          },
        },
        ...input.extra,
      },
    });
    const payment = await db().payment.create({
      data: {
        merchantId,
        orderId: order.id,
        provider: 'PAYPAL',
        kind: 'CHECKOUT_ORDER',
        externalId: `OV-${randomUUID()}`,
        status: input.paymentStatus ?? 'COMPLETED',
        amountMinor: input.totalMinor,
        currency,
        refundedMinor,
        idempotencyKey: randomUUID(),
        createdAt: input.at,
        ...(paid ? { completedAt: input.at } : {}),
      },
    });
    return { order, payment };
  };

  beforeAll(async () => {
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it-ov', level: 'silent' }), {
      paypal: new FakePayPal(`OV-${run}`),
      chatModel: new ScriptedChatModel([]),
    });
    app = await buildApp(container);
    for (const [id, businessName] of [
      [shop, 'Overview Shop'],
      [otherShop, 'Other Shop'],
    ] as const)
      await db().merchant.create({
        data: {
          id,
          businessName,
          ownerName: 'Owner',
          preferredCurrency: 'USD',
          timezone: 'Africa/Kampala',
        },
      });

    // This week: $100 clean, and $50 with $20 refunded. Net $130 from 2 completed orders.
    await sale({
      totalMinor: 10_000,
      at: hoursAgo(1),
      source: 'whatsapp',
      inputMode: 'VOICE',
      description: 'Basket',
      shippingMinor: 1_000,
    });
    await sale({ totalMinor: 5_000, at: hoursAgo(30), refundedMinor: 2_000, description: 'Wrap' });
    // This week, fully refunded: gross $40, net $0, not a completed order.
    await sale({
      totalMinor: 4_000,
      at: hoursAgo(36),
      orderStatus: 'REFUNDED',
      paymentStatus: 'REFUNDED',
      refundedMinor: 4_000,
    });
    // 7:00 UTC on Sunday 1 Nov is 10:00 Sunday in Kampala: last week, in the comparison window.
    await sale({ totalMinor: 8_000, at: new Date('2026-11-01T07:00:00Z'), description: 'Basket' });
    // Sunday 1 Nov 21:30 UTC is already Monday 00:30 in Kampala: this week, though "Sunday" in UTC.
    await sale({ totalMinor: 1_000, at: new Date('2026-11-01T21:30:00Z'), description: 'Tea' });
    // Older: last month.
    await sale({ totalMinor: 3_000, at: new Date(NOW.getTime() - 40 * DAY) });
    // Shillings must stay apart from dollars.
    await sale({ totalMinor: 370_000, currency: 'UGX', at: hoursAgo(2), description: 'Basket' });
    // Unpaid: outstanding, never revenue.
    await sale({
      totalMinor: 2_500,
      at: hoursAgo(3),
      orderStatus: 'AWAITING_PAYMENT',
      paymentStatus: 'CREATED',
      extra: { paymentDueAt: new Date(NOW.getTime() + 3_600_000) },
    });
    await sale({
      totalMinor: 900,
      at: hoursAgo(4),
      orderStatus: 'CANCELLED',
      paymentStatus: 'CANCELLED',
      extra: { cancelReason: 'PAYMENT_EXPIRED', cancelledAt: hoursAgo(1) },
    });
    // Paid twice: one sale of $60, the second payment is a duplicate awaiting refund.
    const paidTwice = await sale({
      totalMinor: 6_000,
      at: hoursAgo(5),
      description: 'Sandals',
      extra: { attention: 'DUPLICATE_PAYMENT', attentionAt: NOW },
    });
    await db().payment.create({
      data: {
        merchantId: shop,
        orderId: paidTwice.order.id,
        provider: 'PAYPAL',
        kind: 'CHECKOUT_ORDER',
        externalId: `OV-${randomUUID()}`,
        status: 'COMPLETED',
        amountMinor: 6_000,
        currency: 'USD',
        duplicate: true,
        idempotencyKey: randomUUID(),
        completedAt: hoursAgo(4),
      },
    });
    // Another merchant's sale must never appear.
    await sale({
      merchantId: otherShop,
      totalMinor: 999_900,
      at: hoursAgo(1),
      description: 'Other',
    });

    await db().product.createMany({
      data: [
        { merchantId: shop, name: 'Out', unitPriceMinor: 100, currency: 'USD', stockQuantity: 0 },
        {
          merchantId: shop,
          name: 'Low',
          unitPriceMinor: 100,
          currency: 'USD',
          stockQuantity: 2,
          reorderLevel: 5,
        },
        {
          merchantId: shop,
          name: 'Fine',
          unitPriceMinor: 100,
          currency: 'USD',
          stockQuantity: 20,
          reorderLevel: 5,
        },
        {
          merchantId: shop,
          name: 'Untracked',
          unitPriceMinor: 100,
          currency: 'USD',
          stockQuantity: null,
        },
      ],
    });
    await db().dispute.create({
      data: {
        merchantId: shop,
        paypalDisputeId: `OV-D-${run}`,
        reason: 'UNAUTHORISED',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        amountMinor: 5_000,
        currency: 'USD',
        sellerResponseDueAt: new Date(NOW.getTime() + 3 * DAY),
      },
    });
  }, 60_000);

  afterAll(async () => {
    for (const id of [shop, otherShop]) {
      await db().dispute.deleteMany({ where: { merchantId: id } });
      await db().order.deleteMany({ where: { merchantId: id } });
      await db().merchant.deleteMany({ where: { id } });
    }
    await app?.close();
  });

  const summary = () =>
    db()
      .merchant.findUniqueOrThrow({ where: { id: shop } })
      .then((merchant) => container.analytics.dashboardSummary(merchant, NOW));

  it('computes gross, refunds and net per currency, without adding currencies', async () => {
    const { pulse } = await summary();
    expect(pulse.map((p) => p.currency)).toEqual(['UGX', 'USD']);
    const usd = pulse.find((p) => p.currency === 'USD')!;
    // Gross: 100 + 50 + 40 + 80 + 10 + 30 + 60 = 370. Refunds: 20 + 40 = 60. Net: 310.
    expect(usd.gross).toBe('$370.00');
    expect(usd.refunds).toBe('$60.00');
    expect(usd.net).toBe('$310.00');
    expect(usd.netMinor).toBe(31_000);
    const ugx = pulse.find((p) => p.currency === 'UGX')!;
    expect(ugx.netMinor).toBe(370_000);
    expect(ugx.paidOrders).toBe(1);
  });

  it('counts an order once when it was paid twice, and fully refunded orders not at all', async () => {
    const usd = (await summary()).pulse.find((p) => p.currency === 'USD')!;
    // 100, 50, 80, 10, 30, 60 are completed. The $40 was fully refunded; the duplicate is not a sale.
    expect(usd.paidOrders).toBe(6);
    // Average of what was kept: 310 / 6.
    expect(usd.averageOrderValue).toBe('$51.67');
  });

  it("uses the merchant's timezone for today, this week and this month", async () => {
    const usd = (await summary()).pulse.find((p) => p.currency === 'USD')!;
    const [today, week, month] = usd.periods;
    // Today in Kampala began 10 hours ago (21:00 UTC on 3 Nov): only the $100 and $60 sales.
    expect(today).toMatchObject({ period: 'today', netMinor: 16_000, paidOrders: 2 });
    // Since Monday 00:00 EAT: 100 + 30 (net of 50) + 0 (full refund) + 10 (Sun 21:30 UTC) + 60.
    expect(week).toMatchObject({ period: 'this_week', netMinor: 20_000 });
    // November in Kampala: this week's sales plus the $80 from Sunday 1 Nov.
    expect(month).toMatchObject({ period: 'this_month', netMinor: 28_000 });
  });

  it('compares against the same elapsed time in the earlier period', async () => {
    const usd = (await summary()).pulse.find((p) => p.currency === 'USD')!;
    const week = usd.periods.find((p) => p.period === 'this_week')!;
    // Last week to this point (Mon 26 Oct 00:00 to Wed 28 Oct 10:00 EAT) had no sales.
    expect(week.previousNet).toBe('$0.00');
    expect(week.changePercent).toBeNull();
  });

  it('reports what needs attention from the records', async () => {
    const { attention } = await summary();
    const byId = Object.fromEntries(attention.map((a) => [a.id, a]));
    expect(attention[0]?.id).toBe('disputes');
    expect(byId.disputes?.count).toBe(1);
    expect(byId['duplicate-payments']?.count).toBe(1);
    expect(byId['out-of-stock']?.count).toBe(1);
    expect(byId['low-stock']?.count).toBe(1);
    expect(byId['to-ship']?.count).toBe(7);
    expect(byId['awaiting-payment']).toMatchObject({ count: 1, severity: 'warning' });
    expect(byId.expired?.count).toBe(1);
  });

  it('gives AG Studio tables whose sums match the headline figures', async () => {
    const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
    const dataset = await container.analytics.dataset(merchant);
    const usdPayments = dataset.payments.filter((p) => p.currency === 'USD');
    const sum = (rows: typeof usdPayments, key: 'gross' | 'refunded' | 'net' | 'paidOrders') =>
      rows.reduce((total, row) => total + row[key], 0);
    expect(sum(usdPayments, 'gross')).toBe(370);
    expect(sum(usdPayments, 'refunded')).toBe(60);
    expect(sum(usdPayments, 'net')).toBe(310);
    expect(sum(usdPayments, 'paidOrders')).toBe(6);
    expect(usdPayments.filter((p) => p.duplicate === 'Yes')).toMatchObject([{ net: 0, gross: 0 }]);
    expect(usdPayments.reduce((total, row) => total + row.pending, 0)).toBe(25);

    const usdOrders = dataset.orders.filter((o) => o.currency === 'USD');
    expect(usdOrders.reduce((total, row) => total + row.net, 0)).toBe(310);

    const sold = dataset.orderItems.filter((i) => i.currency === 'USD' && i.product === 'Basket');
    // $90 (excl. $10 shipping), $80 and $30 are paid. The unpaid, cancelled and refunded lines are 0.
    expect(sold.reduce((total, row) => total + row.soldAmount, 0)).toBe(200);
    const wrap = dataset.orderItems.find((i) => i.product === 'Wrap');
    expect(wrap?.paidOn).toBe('2026-11-03');
    expect(dataset.meta).toMatchObject({ timezone: 'Africa/Kampala', truncated: false });
    expect(dataset.products.map((p) => p.stockStatus).sort()).toEqual([
      'In stock',
      'Low stock',
      'Not tracked',
      'Out of stock',
    ]);
  });

  it('dates rows in the merchant timezone, not UTC', async () => {
    const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
    const dataset = await container.analytics.dataset(merchant);
    const tea = dataset.orderItems.find((i) => i.product === 'Tea');
    // 21:30 UTC on 1 Nov is 00:30 on 2 Nov in Kampala.
    expect(tea?.paidOn).toBe('2026-11-02');
  });

  it('keeps other merchants out', async () => {
    const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
    const [dataset, overview] = await Promise.all([
      container.analytics.dataset(merchant),
      container.analytics.dashboardSummary(merchant, NOW),
    ]);
    expect(JSON.stringify(dataset)).not.toContain('Other');
    expect(JSON.stringify(overview.pulse)).not.toContain('9,999');
  });

  it('agrees with the WhatsApp sales summary', async () => {
    const merchant = await db().merchant.findUniqueOrThrow({ where: { id: shop } });
    const week = await container.analytics.salesSummary(merchant, 'this_week', NOW);
    expect(week.revenue.find((r) => r.currency === 'USD')?.amountMinor).toBe(20_000);
    const allTime = await container.analytics.salesSummary(merchant, 'all_time', NOW);
    const sandals = allTime.topProducts.find((p) => p.name === 'Sandals');
    expect(sandals?.amountMinor).toBe(6_000);
  });

  describe('saved dashboards', () => {
    const headers = (merchantId: string) => ({
      authorization: 'Bearer test-dashboard-token-123456',
      'x-merchant-id': merchantId,
    });
    const state = { pages: [{ id: 'mine', widgets: {} }], selectedPageId: 'mine' };

    it('saves, restores and resets, separately for each merchant', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/dashboard/layout',
        headers: headers(shop),
        payload: { state },
      });
      expect(put.statusCode).toBe(200);

      const mine = await app.inject({ url: '/api/dashboard/layout', headers: headers(shop) });
      expect(mine.json().state).toEqual(state);

      const theirs = await app.inject({
        url: '/api/dashboard/layout',
        headers: headers(otherShop),
      });
      expect(theirs.json().state).toBeNull();

      await app.inject({
        method: 'DELETE',
        url: '/api/dashboard/layout',
        headers: headers(shop),
        payload: {},
      });
      const after = await app.inject({ url: '/api/dashboard/layout', headers: headers(shop) });
      expect(after.json().state).toBeNull();
    });

    it('rejects something that is not a dashboard', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/dashboard/layout',
        headers: headers(shop),
        payload: { state: { pages: [] } },
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses without the dashboard token', async () => {
      const response = await app.inject({ url: '/api/dashboard/layout' });
      expect(response.statusCode).toBe(401);
    });
  });
});
