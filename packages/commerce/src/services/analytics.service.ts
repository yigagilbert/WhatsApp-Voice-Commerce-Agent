import type { Database, Merchant, Prisma } from '@vca/database';
import type { SalesPeriod } from '../commands';
import { aggregatePaidOrders, sourceLabel, type PaidOrderFact } from '../insights';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../state';
import { formatMoney, toMajorNumber } from '../money';
import { parseQuantityTiers } from '../bargaining';
import { NOT_OPEN_CART } from './order.service';
import { buildAttention, type AttentionFacts } from '../attention';
import { previousPeriod, resolvePeriod, zonedDay } from '../periods';
import { stockStatus } from './inventory.service';

export interface CurrencyAmount {
  currency: string;
  amountMinor: number;
  /** Pre-formatted so the LLM never has to do number formatting or arithmetic. */
  formatted: string;
  count: number;
}

const toCurrencyAmounts = (
  rows: {
    currency: string;
    _sum: {
      amountMinor?: number | null;
      totalMinor?: number | null;
      /** Subtracted when present: revenue is net of refunds. */
      refundedMinor?: number | null;
    };
    _count: { _all: number };
  }[],
): CurrencyAmount[] =>
  rows.map((r) => {
    const amountMinor =
      (r._sum.amountMinor ?? r._sum.totalMinor ?? 0) - (r._sum.refundedMinor ?? 0);
    return {
      currency: r.currency,
      amountMinor,
      formatted: formatMoney(amountMinor, r.currency),
      count: r._count._all,
    };
  });

/** Upper bound on paid orders loaded for one aggregation (far above demo scale). */
const MAX_FACTS = 10_000;
const MAX_DIMENSION_ROWS = 1000;
const DAY_MS = 86_400_000;

const PULSE_PERIODS = ['today', 'this_week', 'this_month'] as const;
type PulsePeriod = (typeof PULSE_PERIODS)[number];

const STOCK_LABELS: Record<ReturnType<typeof stockStatus>, string> = {
  OK: 'In stock',
  LOW: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  NOT_TRACKED: 'Not tracked',
};

/**
 * A payment that counts as a sale. A duplicate is a second payment for an order that was already
 * paid: the money is the customer's and has to be returned, so it is not a sale and must not count
 * the order twice. The Overview raises those as an alert instead.
 */
const SALE = { status: 'COMPLETED', duplicate: false } as const;

/**
 * Trusted, database-computed business metrics. The agent answers analytics questions
 * ("How much have I sold this week?") only from these results.
 */
export class AnalyticsService {
  constructor(private readonly db: Database) {}

  /** Completed payments (and their orders) in a window, as plain facts for aggregation. */
  private async paidFacts(
    merchantId: string,
    completedAt: Prisma.DateTimeFilter,
  ): Promise<PaidOrderFact[]> {
    const payments = await this.db.payment.findMany({
      where: { merchantId, ...SALE, completedAt },
      include: {
        order: {
          include: {
            customer: { select: { id: true, name: true } },
            items: { select: { description: true, quantity: true, lineTotalMinor: true } },
          },
        },
      },
      orderBy: { completedAt: 'desc' },
      take: MAX_FACTS,
    });
    return payments.map((p) => ({
      reference: p.order.reference,
      customerId: p.order.customer.id,
      customerName: p.order.customer.name,
      source: p.order.source,
      inputMode: p.order.inputMode,
      currency: p.currency,
      amountMinor: p.amountMinor - p.refundedMinor,
      items: p.order.items,
    }));
  }

  private outstanding(merchantId: string) {
    return this.db.order
      .groupBy({
        by: ['currency'],
        where: { merchantId, status: 'AWAITING_PAYMENT' },
        _sum: { totalMinor: true },
        _count: { _all: true },
      })
      .then(toCurrencyAmounts);
  }

  async salesSummary(
    merchant: Pick<Merchant, 'id' | 'timezone'>,
    period: SalesPeriod,
    now = new Date(),
  ) {
    const range = resolvePeriod(period, now, merchant.timezone);
    const completedAt = { ...(range.start ? { gte: range.start } : {}), lt: range.end };

    const [revenue, outstanding, facts] = await Promise.all([
      this.db.payment
        .groupBy({
          by: ['currency'],
          where: { merchantId: merchant.id, ...SALE, completedAt },
          _sum: { amountMinor: true, refundedMinor: true },
          _count: { _all: true },
        })
        .then(toCurrencyAmounts),
      this.outstanding(merchant.id),
      this.paidFacts(merchant.id, completedAt),
    ]);
    const breakdown = aggregatePaidOrders(facts);

    return {
      period,
      label: range.label,
      from: range.start?.toISOString() ?? null,
      to: range.end.toISOString(),
      timezone: merchant.timezone,
      /** Completed PayPal payments in the period, net of refunds. */
      revenue,
      /** All orders currently awaiting payment (not limited to the period). */
      outstanding,
      ...breakdown,
      notes:
        'Revenue = completed PayPal payments minus refunds (fully refunded orders and duplicate payments are excluded). Product revenue excludes shipping and tax. Outstanding = orders awaiting payment now.',
    };
  }

  /** Completed-payment revenue and paid-order count in [start, end). */
  private async revenueBetween(merchantId: string, start: Date | null, end: Date) {
    const rows = await this.db.payment.groupBy({
      by: ['currency'],
      where: {
        merchantId,
        ...SALE,
        completedAt: { ...(start ? { gte: start } : {}), lt: end },
      },
      _sum: { amountMinor: true, refundedMinor: true },
      _count: { _all: true },
    });
    return toCurrencyAmounts(rows);
  }

  /**
   * This period vs the comparable earlier window (same elapsed length), from completed payments.
   * The percentage change is computed here, never by the model.
   */
  async compareSales(
    merchant: Pick<Merchant, 'id' | 'timezone'>,
    period: SalesPeriod,
    now = new Date(),
  ) {
    const current = resolvePeriod(period, now, merchant.timezone);
    const previous = previousPeriod(period, now, merchant.timezone);
    const [cur, prev] = await Promise.all([
      this.revenueBetween(merchant.id, current.start, current.end),
      previous
        ? this.revenueBetween(merchant.id, previous.start, previous.end)
        : Promise.resolve([]),
    ]);
    const currencies = [...new Set([...cur, ...prev].map((r) => r.currency))].sort();
    return {
      period: current.label,
      comparedWith: previous?.label ?? null,
      byCurrency: currencies.map((currency) => {
        const c = cur.find((r) => r.currency === currency);
        const p = prev.find((r) => r.currency === currency);
        const now = c?.amountMinor ?? 0;
        const before = p?.amountMinor ?? 0;
        return {
          currency,
          revenue: formatMoney(now, currency),
          previousRevenue: formatMoney(before, currency),
          paidOrders: c?.count ?? 0,
          previousPaidOrders: p?.count ?? 0,
          changePercent: before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null,
          change: formatMoney(now - before, currency),
        };
      }),
    };
  }

  /** Completed-payment revenue per local day for the last `days` days (oldest first), for charts. */
  async dailyRevenue(merchant: Pick<Merchant, 'id' | 'timezone'>, days: number, now = new Date()) {
    // A little more than `days` days back; only the last `days` local dates are kept below.
    const start = new Date(now.getTime() - days * 86_400_000);
    const payments = await this.db.payment.findMany({
      where: { merchantId: merchant.id, ...SALE, completedAt: { gte: start, lt: now } },
      select: { amountMinor: true, refundedMinor: true, currency: true, completedAt: true },
      take: MAX_FACTS,
    });
    const dayKey = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: merchant.timezone }).format(d); // YYYY-MM-DD
    const keys: string[] = [];
    for (let t = now.getTime() - (days - 1) * 86_400_000; t <= now.getTime(); t += 86_400_000)
      keys.push(dayKey(new Date(t)));
    // The chart shows one currency: the one with the most revenue, never whichever row came first.
    const netByCurrency = new Map<string, number>();
    for (const p of payments)
      netByCurrency.set(
        p.currency,
        (netByCurrency.get(p.currency) ?? 0) + p.amountMinor - p.refundedMinor,
      );
    const currency =
      [...netByCurrency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const totals = new Map(keys.map((k) => [k, 0]));
    for (const p of payments) {
      if (p.currency !== currency) continue; // single-currency chart; others reported separately
      const key = dayKey(p.completedAt!);
      if (totals.has(key))
        totals.set(key, (totals.get(key) ?? 0) + p.amountMinor - p.refundedMinor);
    }
    return {
      currency,
      otherCurrencies: [...new Set(payments.map((p) => p.currency))].filter((c) => c !== currency),
      days: keys.map((date) => ({ date, amountMinor: totals.get(date) ?? 0 })),
    };
  }

  /**
   * Orders, spend and outstanding balance for the customers matching `query`
   * ("How much has Sarah spent?"). Only data we actually hold.
   */
  async customerSummary(merchantId: string, query: string) {
    const q = query.trim();
    const customers = await this.db.customer.findMany({
      where: {
        merchantId,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { equals: q, mode: 'insensitive' } },
        ],
      },
      include: {
        orders: {
          select: {
            reference: true,
            status: true,
            totalMinor: true,
            refundedMinor: true,
            currency: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { name: 'asc' },
      take: 5,
    });

    return customers.map((c) => {
      const sum = (status: string) => {
        const totals = new Map<string, number>();
        for (const o of c.orders.filter((o) => o.status === status))
          totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.totalMinor - o.refundedMinor);
        return [...totals].map(([currency, minor]) => formatMoney(minor, currency));
      };
      const last = c.orders[0];
      return {
        name: c.name,
        email: c.email,
        phone: c.phone,
        country: c.country,
        customer_since: c.createdAt.toISOString(),
        orders_total: c.orders.length,
        orders_paid: c.orders.filter((o) => o.status === 'PAID').length,
        orders_awaiting_payment: c.orders.filter((o) => o.status === 'AWAITING_PAYMENT').length,
        total_paid: sum('PAID'),
        outstanding: sum('AWAITING_PAYMENT'),
        last_order: last
          ? {
              reference: last.reference,
              status: last.status,
              total: formatMoney(last.totalMinor, last.currency),
              created_at: last.createdAt.toISOString(),
            }
          : null,
      };
    });
  }

  /** Per-customer order count, paid revenue and last order date for the Customers grid. */
  async customerStats(merchantId: string) {
    const [customers, paid] = await Promise.all([
      this.db.customer.findMany({
        where: { merchantId },
        include: {
          _count: { select: { orders: { where: NOT_OPEN_CART } } },
          orders: {
            where: NOT_OPEN_CART,
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
        take: 1000,
      }),
      this.db.payment.findMany({
        where: { merchantId, ...SALE },
        select: {
          amountMinor: true,
          refundedMinor: true,
          currency: true,
          order: { select: { customerId: true } },
        },
        take: MAX_FACTS,
      }),
    ]);
    return customers.map((c) => {
      const mine = paid.filter((p) => p.order.customerId === c.id);
      const currency = mine[0]?.currency ?? c.preferredCurrency ?? null;
      const revenueMinor = mine
        .filter((p) => p.currency === currency)
        .reduce((sum, p) => sum + p.amountMinor - p.refundedMinor, 0);
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        country: c.country,
        hasWhatsApp: !!c.whatsappId,
        orders: c._count.orders,
        paidOrders: mine.length,
        revenueMinor,
        currency,
        lastOrderAt: c.orders[0]?.createdAt.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  /** Catalog rows with units sold and revenue from paid orders (Products grid). */
  async productStats(merchantId: string) {
    const [products, sold] = await Promise.all([
      this.db.product.findMany({
        where: { merchantId },
        include: { image: { select: { id: true, updatedAt: true } } },
        orderBy: { name: 'asc' },
        take: 1000,
      }),
      this.db.orderItem.groupBy({
        by: ['productId'],
        where: { productId: { not: null }, order: { merchantId, status: 'PAID' } },
        _sum: { quantity: true, lineTotalMinor: true },
      }),
    ]);
    return products.map((p) => {
      const s = sold.find((row) => row.productId === p.id);
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        description: p.description,
        unitPriceMinor: p.unitPriceMinor,
        currency: p.currency,
        stockQuantity: p.stockQuantity,
        active: p.active,
        reorderLevel: p.reorderLevel,
        visibleToCustomers: p.visibleToCustomers,
        category: p.category,
        /** Changes with each new photo (cache key for thumbnails); null = no photo. */
        imageVersion: p.image ? `${p.image.id}-${p.image.updatedAt.getTime()}` : null,
        unitsSold: s?._sum.quantity ?? 0,
        revenueMinor: s?._sum.lineTotalMinor ?? 0,
        bargainingEnabled: p.bargainingEnabled && p.minPriceMinor !== null,
        minPriceMinor: p.minPriceMinor,
        quantityDiscounts: parseQuantityTiers(p.quantityDiscounts),
      };
    });
  }

  /**
   * Flat, denormalised tables for the AG Studio workspace on the Overview. Amounts are major-unit
   * numbers for charting; the authoritative figures remain the minor-unit values elsewhere.
   *
   * Money fields whose name means a sale (`gross`, `refunded`, `net`, `soldAmount`, `soldUnits`) are
   * zero on rows that are not sales, so summing them is correct with or without a filter: neither a
   * merchant dragging a field nor the assistant can overstate revenue by forgetting one. `paidOn`
   * and `createdOn` are calendar dates in the merchant's timezone, not the viewer's.
   */
  async dataset(merchant: Pick<Merchant, 'id' | 'timezone'>) {
    const merchantId = merchant.id;
    const [orders, payments, customers, products, shipments, disputes] = await Promise.all([
      this.db.order.findMany({
        where: { merchantId, ...NOT_OPEN_CART },
        include: {
          customer: { select: { id: true, name: true } },
          items: true,
          payments: { where: SALE, select: { completedAt: true }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_FACTS,
      }),
      this.db.payment.findMany({
        where: { merchantId },
        include: {
          order: {
            select: {
              reference: true,
              customerId: true,
              source: true,
              inputMode: true,
              customer: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_FACTS,
      }),
      this.db.customer.findMany({ where: { merchantId }, take: MAX_DIMENSION_ROWS }),
      this.db.product.findMany({ where: { merchantId }, take: MAX_DIMENSION_ROWS }),
      this.db.shipment.findMany({
        where: { merchantId },
        include: { order: { select: { reference: true } } },
        take: MAX_FACTS,
      }),
      this.db.dispute.findMany({
        where: { merchantId },
        include: { order: { select: { reference: true } } },
        take: MAX_FACTS,
      }),
    ]);
    // Exponent-aware: UGX/JPY amounts are stored without a minor unit.
    const major = toMajorNumber;
    const day = (date: Date | null | undefined) =>
      date ? zonedDay(date, merchant.timezone) : null;

    const sold = new Map<string, { units: number; revenueMinor: number }>();
    const productCurrency = new Map(products.map((p) => [p.id, p.currency]));
    for (const order of orders) {
      if (order.status !== 'PAID') continue;
      for (const item of order.items) {
        if (!item.productId || productCurrency.get(item.productId) !== order.currency) continue;
        const row = sold.get(item.productId) ?? { units: 0, revenueMinor: 0 };
        row.units += item.quantity;
        row.revenueMinor += item.lineTotalMinor;
        sold.set(item.productId, row);
      }
    }

    return {
      meta: {
        generatedAt: new Date().toISOString(),
        timezone: merchant.timezone,
        /** True when a table hit its row limit, so totals built on it would be incomplete. */
        truncated:
          orders.length >= MAX_FACTS ||
          payments.length >= MAX_FACTS ||
          customers.length >= MAX_DIMENSION_ROWS ||
          products.length >= MAX_DIMENSION_ROWS,
      },
      orders: orders.map((o) => {
        const paid = o.status === 'PAID';
        return {
          orderId: o.reference,
          customerId: o.customer.id,
          customer: o.customer.name,
          channel: o.source === 'web' ? 'Agent console' : 'WhatsApp',
          inputMode: o.inputMode === 'VOICE' ? 'Voice' : 'Text',
          source: sourceLabel(o.source, o.inputMode),
          status: ORDER_STATUS_LABELS[o.status],
          currency: o.currency,
          subtotal: major(o.subtotalMinor, o.currency),
          shipping: major(o.shippingMinor, o.currency),
          total: major(o.totalMinor, o.currency),
          refunded: major(o.refundedMinor, o.currency),
          net: paid ? major(o.totalMinor - o.refundedMinor, o.currency) : 0,
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
          createdAt: o.createdAt.toISOString(),
          createdOn: day(o.createdAt),
          paidAt: o.payments[0]?.completedAt?.toISOString() ?? null,
          paidOn: day(o.payments[0]?.completedAt),
          fulfillment: o.fulfillmentStatus === 'SHIPPED' ? 'Shipped' : 'Not shipped',
          // Paid but awaiting fulfilment is its own question merchants ask constantly.
          toShip: paid && o.fulfillmentStatus === 'NOT_SHIPPED' ? 'Yes' : 'No',
          attention: o.attention ?? 'None',
        };
      }),
      shipments: shipments.map((s) => ({
        shipmentId: s.id,
        orderId: s.order.reference,
        carrier: s.carrier === 'OTHER' ? (s.carrierNameOther ?? 'Other') : s.carrier,
        trackingNumber: s.trackingNumber,
        status: s.status === 'SHIPPED' ? 'Shipped' : 'Cancelled',
        shippedAt: s.shippedAt.toISOString(),
      })),
      disputes: disputes.map((d) => ({
        disputeId: d.paypalDisputeId,
        orderId: d.order?.reference ?? null,
        reason: d.reason,
        status: d.status,
        active: ACTIVE_DISPUTE_STATUSES.includes(d.status) ? 'Yes' : 'No',
        amount: d.amountMinor !== null && d.currency ? major(d.amountMinor, d.currency) : null,
        currency: d.currency,
        openedAt: d.openedAt?.toISOString() ?? null,
        responseDue: d.sellerResponseDueAt?.toISOString() ?? null,
      })),
      orderItems: orders.flatMap((o) =>
        o.items.map((i) => {
          const paid = o.status === 'PAID';
          return {
            itemId: i.id,
            orderId: o.reference,
            product: i.description,
            inCatalog: i.productId !== null,
            quantity: i.quantity,
            unitPrice: major(i.unitPriceMinor, o.currency),
            lineTotal: major(i.lineTotalMinor, o.currency),
            soldUnits: paid ? i.quantity : 0,
            soldAmount: paid ? major(i.lineTotalMinor, o.currency) : 0,
            orderStatus: ORDER_STATUS_LABELS[o.status],
            currency: o.currency,
            source: sourceLabel(o.source, o.inputMode),
            paidOn: day(o.payments[0]?.completedAt),
          };
        }),
      ),
      payments: payments.map((p) => {
        // COMPLETED or fully REFUNDED, and not a duplicate: real sales, gross of refunds.
        const sale = (p.status === 'COMPLETED' || p.status === 'REFUNDED') && !p.duplicate;
        const open = p.status === 'CREATED' || p.status === 'APPROVED';
        return {
          paymentId: p.id,
          orderId: p.order.reference,
          customerId: p.order.customerId,
          customer: p.order.customer.name,
          source: sourceLabel(p.order.source, p.order.inputMode),
          provider: 'PayPal',
          status: PAYMENT_STATUS_LABELS[p.status],
          amount: major(p.amountMinor, p.currency),
          gross: sale ? major(p.amountMinor, p.currency) : 0,
          refunded: sale ? major(p.refundedMinor, p.currency) : 0,
          net: sale ? major(p.amountMinor - p.refundedMinor, p.currency) : 0,
          pending: open ? major(p.amountMinor, p.currency) : 0,
          paidOrders: sale && p.status === 'COMPLETED' ? 1 : 0,
          duplicate: p.duplicate ? 'Yes' : 'No',
          currency: p.currency,
          createdAt: p.createdAt.toISOString(),
          completedAt: p.completedAt?.toISOString() ?? null,
          paidOn: sale ? day(p.completedAt) : null,
        };
      }),
      customers: customers.map((c) => ({
        customerId: c.id,
        name: c.name,
        country: c.country,
        createdAt: c.createdAt.toISOString(),
      })),
      products: products.map((p) => {
        const stats = sold.get(p.id);
        return {
          sku: p.sku,
          product: p.name,
          category: p.category ?? 'Uncategorised',
          price: major(p.unitPriceMinor, p.currency),
          currency: p.currency,
          stock: p.stockQuantity,
          reorderLevel: p.reorderLevel,
          stockStatus: STOCK_LABELS[stockStatus(p)],
          active: p.active,
          unitsSold: stats?.units ?? 0,
          revenue: major(stats?.revenueMinor ?? 0, p.currency),
        };
      }),
    };
  }

  /** Net sales and paid orders for one period and the comparable earlier window, per currency. */
  private async periodPulse(
    merchant: Pick<Merchant, 'id' | 'timezone'>,
    period: PulsePeriod,
    now: Date,
  ) {
    const current = resolvePeriod(period, now, merchant.timezone);
    const previous = previousPeriod(period, now, merchant.timezone);
    const [cur, prev] = await Promise.all([
      this.revenueBetween(merchant.id, current.start, current.end),
      previous ? this.revenueBetween(merchant.id, previous.start, previous.end) : [],
    ]);
    return { period, comparedWith: previous?.label ?? null, cur, prev };
  }

  /**
   * The Overview's business pulse, one block per currency: amounts in different currencies are
   * never added together. Every figure and percentage is computed here, never by a browser or LLM.
   */
  private async pulse(merchant: Pick<Merchant, 'id' | 'timezone'>, now: Date) {
    const [periods, sales, outstanding, disputed] = await Promise.all([
      Promise.all(PULSE_PERIODS.map((period) => this.periodPulse(merchant, period, now))),
      this.db.payment.groupBy({
        by: ['currency', 'status'],
        where: {
          merchantId: merchant.id,
          status: { in: ['COMPLETED', 'REFUNDED'] },
          duplicate: false,
        },
        _sum: { amountMinor: true, refundedMinor: true },
        _count: { _all: true },
      }),
      this.outstanding(merchant.id),
      this.db.dispute.groupBy({
        by: ['currency'],
        where: {
          merchantId: merchant.id,
          status: { in: ACTIVE_DISPUTE_STATUSES },
          currency: { not: null },
        },
        _sum: { amountMinor: true },
      }),
    ]);
    const currencies = [
      ...new Set([...sales.map((s) => s.currency), ...outstanding.map((o) => o.currency)]),
    ].sort();
    return currencies.map((currency) => {
      const rows = sales.filter((s) => s.currency === currency);
      const grossMinor = rows.reduce((sum, r) => sum + (r._sum.amountMinor ?? 0), 0);
      const refundsMinor = rows.reduce((sum, r) => sum + (r._sum.refundedMinor ?? 0), 0);
      const netMinor = grossMinor - refundsMinor;
      const paidOrders = rows.find((r) => r.status === 'COMPLETED')?._count._all ?? 0;
      const completedNet = rows
        .filter((r) => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + (r._sum.amountMinor ?? 0) - (r._sum.refundedMinor ?? 0), 0);
      const open = outstanding.find((o) => o.currency === currency);
      const held = disputed.find((d) => d.currency === currency)?._sum.amountMinor ?? 0;
      return {
        currency,
        gross: formatMoney(grossMinor, currency),
        refunds: formatMoney(refundsMinor, currency),
        net: formatMoney(netMinor, currency),
        netMinor,
        paidOrders,
        averageOrderValue:
          paidOrders > 0 ? formatMoney(Math.round(completedNet / paidOrders), currency) : null,
        outstanding: formatMoney(open?.amountMinor ?? 0, currency),
        outstandingOrders: open?.count ?? 0,
        disputed: formatMoney(held, currency),
        periods: periods.map(({ period, comparedWith, cur, prev }) => {
          const c = cur.find((r) => r.currency === currency);
          const p = prev.find((r) => r.currency === currency);
          const value = c?.amountMinor ?? 0;
          const before = p?.amountMinor ?? 0;
          return {
            period,
            net: formatMoney(value, currency),
            netMinor: value,
            paidOrders: c?.count ?? 0,
            previousNet: formatMoney(before, currency),
            comparedWith,
            // null, not 100%: growth from nothing has no meaningful percentage.
            changePercent: before > 0 ? Math.round(((value - before) / before) * 1000) / 10 : null,
          };
        }),
      };
    });
  }

  /** The counts behind the Overview's "needs attention" list. */
  private async attentionFacts(merchantId: string, now: Date): Promise<AttentionFacts> {
    const soon = new Date(now.getTime() + DAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [
      disputeDue,
      needsResponse,
      duplicates,
      paidAfterCancel,
      toShip,
      oldestToShip,
      toApprove,
      awaiting,
      dueSoon,
      expired,
      products,
    ] = await Promise.all([
      this.db.dispute.findFirst({
        where: {
          merchantId,
          status: 'WAITING_FOR_SELLER_RESPONSE',
          sellerResponseDueAt: { not: null },
        },
        orderBy: { sellerResponseDueAt: 'asc' },
        select: { sellerResponseDueAt: true },
      }),
      this.db.dispute.count({ where: { merchantId, status: 'WAITING_FOR_SELLER_RESPONSE' } }),
      this.db.order.count({ where: { merchantId, attention: 'DUPLICATE_PAYMENT' } }),
      this.db.order.count({ where: { merchantId, attention: 'PAID_AFTER_CANCEL' } }),
      this.db.order.count({
        where: { merchantId, status: 'PAID', fulfillmentStatus: 'NOT_SHIPPED' },
      }),
      this.db.payment.findFirst({
        where: {
          merchantId,
          ...SALE,
          order: { status: 'PAID', fulfillmentStatus: 'NOT_SHIPPED' },
        },
        orderBy: { completedAt: 'asc' },
        select: { completedAt: true },
      }),
      this.db.order.count({
        where: {
          merchantId,
          status: 'DRAFT',
          placedBy: 'CUSTOMER',
          customerConfirmedAt: { not: null },
        },
      }),
      this.db.order.count({ where: { merchantId, status: 'AWAITING_PAYMENT' } }),
      this.db.order.count({
        where: { merchantId, status: 'AWAITING_PAYMENT', paymentDueAt: { gte: now, lte: soon } },
      }),
      this.db.order.count({
        where: { merchantId, cancelReason: 'PAYMENT_EXPIRED', cancelledAt: { gte: weekAgo } },
      }),
      this.db.product.findMany({
        where: { merchantId, active: true, stockQuantity: { not: null } },
        select: { stockQuantity: true, reorderLevel: true },
        take: MAX_DIMENSION_ROWS,
      }),
    ]);
    const statuses = products.map(stockStatus);
    return {
      disputesNeedingResponse: needsResponse,
      nextDisputeDue: disputeDue?.sellerResponseDueAt?.toISOString() ?? null,
      duplicatePayments: duplicates,
      paidAfterCancel,
      toShip,
      oldestToShipDays: oldestToShip?.completedAt
        ? Math.floor((now.getTime() - oldestToShip.completedAt.getTime()) / DAY_MS)
        : null,
      toApprove,
      awaitingPayment: awaiting,
      paymentDueSoon: dueSoon,
      expiredThisWeek: expired,
      outOfStock: statuses.filter((s) => s === 'OUT_OF_STOCK').length,
      lowStock: statuses.filter((s) => s === 'LOW').length,
    };
  }

  /** A value that changes whenever the data behind the Overview does; cheap to poll. */
  private async dataVersion(merchantId: string) {
    const where = { where: { merchantId }, _max: { updatedAt: true } } as const;
    const latest = await Promise.all([
      this.db.order.aggregate(where),
      this.db.payment.aggregate(where),
      this.db.product.aggregate(where),
      this.db.shipment.aggregate(where),
      this.db.dispute.aggregate(where),
    ]);
    return latest.map((row) => row._max.updatedAt?.getTime() ?? 0).join('-');
  }

  async dashboardSummary(merchant: Pick<Merchant, 'id' | 'timezone'>, now = new Date()) {
    const [
      allTime,
      revenueThisWeek,
      statusCounts,
      customersCount,
      productsCount,
      operations,
      pulse,
      attentionFacts,
      dataVersion,
    ] = await Promise.all([
      this.salesSummary(merchant, 'all_time', now),
      this.salesSummary(merchant, 'this_week', now).then((week) => week.revenue),
      // Open customer carts are not orders yet.
      this.db.order.groupBy({
        by: ['status'],
        where: { merchantId: merchant.id, ...NOT_OPEN_CART },
        _count: { _all: true },
      }),
      this.db.customer.count({ where: { merchantId: merchant.id } }),
      this.db.product.count({ where: { merchantId: merchant.id, active: true } }),
      this.operations(merchant.id),
      this.pulse(merchant, now),
      this.attentionFacts(merchant.id, now),
      this.dataVersion(merchant.id),
    ]);
    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    return {
      generatedAt: now.toISOString(),
      dataVersion,
      pulse,
      attention: buildAttention(attentionFacts, now),
      revenue: allTime.revenue,
      revenueThisWeek,
      outstanding: allTime.outstanding,
      averageOrderValue: allTime.averageOrderValue,
      topProducts: allTime.topProducts,
      topCustomers: allTime.topCustomers,
      bySource: allTime.bySource,
      counts: {
        orders: statusCounts.reduce((sum, s) => sum + s._count._all, 0),
        paidOrders: allTime.paidOrders,
        awaitingPayment: byStatus.AWAITING_PAYMENT ?? 0,
        drafts: byStatus.DRAFT ?? 0,
        customers: customersCount,
        products: productsCount,
      },
      operations,
    };
  }

  /** Post-payment operations: shipping backlog and disputes. */
  async operations(merchantId: string) {
    const active = { in: ACTIVE_DISPUTE_STATUSES };
    const [awaitingShipment, shipped, openDisputes, needsResponse, disputed] = await Promise.all([
      this.db.order.count({
        where: { merchantId, status: 'PAID', fulfillmentStatus: 'NOT_SHIPPED' },
      }),
      this.db.order.count({
        where: { merchantId, status: 'PAID', fulfillmentStatus: 'SHIPPED' },
      }),
      this.db.dispute.count({ where: { merchantId, status: active } }),
      this.db.dispute.count({ where: { merchantId, status: 'WAITING_FOR_SELLER_RESPONSE' } }),
      this.db.dispute.groupBy({
        by: ['currency'],
        where: { merchantId, status: active, currency: { not: null } },
        _sum: { amountMinor: true },
      }),
    ]);
    return {
      awaitingShipment,
      shipped,
      openDisputes,
      needsResponse,
      disputedAmount: disputed.map((d) => ({
        currency: d.currency!,
        amountMinor: d._sum.amountMinor ?? 0,
        formatted: formatMoney(d._sum.amountMinor ?? 0, d.currency!),
      })),
    };
  }
}

/** PayPal dispute statuses that are still active (not RESOLVED). */
export const ACTIVE_DISPUTE_STATUSES = [
  'OPEN',
  'WAITING_FOR_SELLER_RESPONSE',
  'WAITING_FOR_BUYER_RESPONSE',
  'UNDER_REVIEW',
  'OTHER',
];
