import type { Database, Merchant, Prisma } from '@vca/database';
import type { SalesPeriod } from '../commands';
import { aggregatePaidOrders, sourceLabel, type PaidOrderFact } from '../insights';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../state';
import { formatMoney, toMajorNumber } from '../money';
import { NOT_OPEN_CART } from './order.service';
import { previousPeriod, resolvePeriod } from '../periods';

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
      where: { merchantId, status: 'COMPLETED', completedAt },
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
          where: { merchantId: merchant.id, status: 'COMPLETED', completedAt },
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
        'Revenue = completed PayPal payments minus refunds (fully refunded orders are excluded). Product revenue excludes shipping and tax. Outstanding = orders awaiting payment now.',
    };
  }

  /** Completed-payment revenue and paid-order count in [start, end). */
  private async revenueBetween(merchantId: string, start: Date | null, end: Date) {
    const rows = await this.db.payment.groupBy({
      by: ['currency'],
      where: {
        merchantId,
        status: 'COMPLETED',
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
      where: { merchantId: merchant.id, status: 'COMPLETED', completedAt: { gte: start, lt: now } },
      select: { amountMinor: true, refundedMinor: true, currency: true, completedAt: true },
      take: MAX_FACTS,
    });
    const dayKey = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: merchant.timezone }).format(d); // YYYY-MM-DD
    const keys: string[] = [];
    for (let t = now.getTime() - (days - 1) * 86_400_000; t <= now.getTime(); t += 86_400_000)
      keys.push(dayKey(new Date(t)));
    const currency = payments[0]?.currency ?? null;
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
          totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.totalMinor);
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
        where: { merchantId, status: 'COMPLETED' },
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
        /** Changes with each new photo (cache key for thumbnails); null = no photo. */
        imageVersion: p.image ? `${p.image.id}-${p.image.updatedAt.getTime()}` : null,
        unitsSold: s?._sum.quantity ?? 0,
        revenueMinor: s?._sum.lineTotalMinor ?? 0,
      };
    });
  }

  /**
   * Flat, denormalised tables for the AG Studio analytics workspace. Amounts are major-unit
   * numbers for charting; the authoritative figures remain the minor-unit values elsewhere.
   */
  async dataset(merchant: Pick<Merchant, 'id' | 'timezone'>) {
    const merchantId = merchant.id;
    const [orders, payments, customers, products, shipments, disputes] = await Promise.all([
      this.db.order.findMany({
        where: { merchantId, ...NOT_OPEN_CART },
        include: {
          customer: { select: { id: true, name: true } },
          items: true,
          payments: { where: { status: 'COMPLETED' }, select: { completedAt: true }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_FACTS,
      }),
      this.db.payment.findMany({
        where: { merchantId },
        include: { order: { select: { reference: true, customerId: true } } },
        orderBy: { createdAt: 'desc' },
        take: MAX_FACTS,
      }),
      this.db.customer.findMany({ where: { merchantId }, take: 1000 }),
      this.db.product.findMany({ where: { merchantId }, take: 1000 }),
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
    return {
      orders: orders.map((o) => ({
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
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        createdAt: o.createdAt.toISOString(),
        paidAt: o.payments[0]?.completedAt?.toISOString() ?? null,
        fulfillment: o.fulfillmentStatus === 'SHIPPED' ? 'Shipped' : 'Not shipped',
      })),
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
        amount: d.amountMinor !== null && d.currency ? major(d.amountMinor, d.currency) : null,
        currency: d.currency,
        openedAt: d.openedAt?.toISOString() ?? null,
        responseDue: d.sellerResponseDueAt?.toISOString() ?? null,
      })),
      orderItems: orders.flatMap((o) =>
        o.items.map((i) => ({
          itemId: i.id,
          orderId: o.reference,
          product: i.description,
          inCatalog: i.productId !== null,
          quantity: i.quantity,
          unitPrice: major(i.unitPriceMinor, o.currency),
          lineTotal: major(i.lineTotalMinor, o.currency),
          orderStatus: ORDER_STATUS_LABELS[o.status],
        })),
      ),
      payments: payments.map((p) => ({
        paymentId: p.id,
        orderId: p.order.reference,
        customerId: p.order.customerId,
        provider: 'PayPal',
        status: PAYMENT_STATUS_LABELS[p.status],
        amount: major(p.amountMinor, p.currency),
        refunded: major(p.refundedMinor, p.currency),
        currency: p.currency,
        createdAt: p.createdAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
      })),
      customers: customers.map((c) => ({
        customerId: c.id,
        name: c.name,
        country: c.country,
        createdAt: c.createdAt.toISOString(),
      })),
      products: products.map((p) => ({
        sku: p.sku,
        product: p.name,
        price: major(p.unitPriceMinor, p.currency),
        currency: p.currency,
        stock: p.stockQuantity,
        active: p.active,
      })),
    };
  }

  async dashboardSummary(merchant: Pick<Merchant, 'id' | 'timezone'>) {
    const [
      allTime,
      week,
      statusCounts,
      customersCount,
      productsCount,
      operations,
      recentOrders,
      recentPayments,
    ] = await Promise.all([
      this.salesSummary(merchant, 'all_time'),
      this.salesSummary(merchant, 'this_week'),
      // Open customer carts are not orders yet.
      this.db.order.groupBy({
        by: ['status'],
        where: { merchantId: merchant.id, ...NOT_OPEN_CART },
        _count: { _all: true },
      }),
      this.db.customer.count({ where: { merchantId: merchant.id } }),
      this.db.product.count({ where: { merchantId: merchant.id, active: true } }),
      this.operations(merchant.id),
      this.db.order.findMany({
        where: { merchantId: merchant.id, ...NOT_OPEN_CART },
        include: { customer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.db.payment.findMany({
        where: { merchantId: merchant.id },
        include: { order: { select: { reference: true, customer: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));

    return {
      revenue: allTime.revenue,
      revenueThisWeek: week.revenue,
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
      recentOrders,
      recentPayments,
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
