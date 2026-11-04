import type { AnalyticsDataset } from '@/lib/types';

/**
 * The answers to the questions merchants ask most, computed by code from the backend's rows for one
 * currency. The assistant quotes these rather than composing its own query, because a model that
 * guesses a filter value and gets nothing back will confidently report that there is nothing there.
 * Pure functions, unit-tested.
 */
const MAX_ROWS = 25;

type Row = AnalyticsDataset['payments'][number];

const num = (value: unknown) => (typeof value === 'number' ? value : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export interface DateRange {
  /** Inclusive YYYY-MM-DD in the merchant's timezone. Omit for no lower bound. */
  from?: string | undefined;
  /** Inclusive YYYY-MM-DD in the merchant's timezone. Omit for no upper bound. */
  to?: string | undefined;
}

const inRange = (day: unknown, { from, to }: DateRange) => {
  const value = text(day);
  if (!from && !to) return true;
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
};

const listed = <T>(rows: T[]) => ({
  count: rows.length,
  rows: rows.slice(0, MAX_ROWS),
  ...(rows.length > MAX_ROWS ? { note: `Showing the first ${MAX_ROWS} of ${rows.length}.` } : {}),
});

export function createLookups(dataset: AnalyticsDataset, currency: string) {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const money = (value: number) => format.format(value);

  /** Sums a measure per name, biggest first, with each one's share of the total. */
  const ranked = (
    rows: Row[],
    name: (row: Row) => string,
    amount: (row: Row) => number,
    count: (row: Row) => number,
    limit: number,
  ) => {
    const totals = new Map<string, { amount: number; count: number }>();
    for (const row of rows) {
      const entry = totals.get(name(row)) ?? { amount: 0, count: 0 };
      entry.amount += amount(row);
      entry.count += count(row);
      totals.set(name(row), entry);
    }
    const grand = [...totals.values()].reduce((sum, entry) => sum + entry.amount, 0);
    return [...totals.entries()]
      .filter(([, entry]) => entry.amount > 0)
      .sort((a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([label, entry]) => ({
        name: label,
        amount: money(entry.amount),
        count: entry.count,
        sharePercent: grand > 0 ? Math.round((entry.amount / grand) * 1000) / 10 : 0,
      }));
  };

  return {
    pendingPayments() {
      const rows = dataset.payments.filter((p) => num(p.pending) > 0);
      return {
        currency,
        total: money(rows.reduce((sum, p) => sum + num(p.pending), 0)),
        ...listed(
          rows.map((p) => ({
            order: p.orderId,
            customer: p.customer,
            amount: money(num(p.pending)),
            status: p.status,
            requested: text(p.createdAt).slice(0, 10),
          })),
        ),
      };
    },

    ordersToShip() {
      const rows = dataset.orders
        .filter((o) => o.toShip === 'Yes')
        .sort((a, b) => text(a.paidAt).localeCompare(text(b.paidAt)));
      return {
        currency,
        ...listed(
          rows.map((o) => ({
            order: o.orderId,
            customer: o.customer,
            total: money(num(o.total)),
            paidOn: o.paidOn,
          })),
        ),
      };
    },

    stockAlerts() {
      const alerts = dataset.products.filter(
        (p) =>
          p.active === true && (p.stockStatus === 'Low stock' || p.stockStatus === 'Out of stock'),
      );
      const rows = alerts
        .sort(
          (a, b) => num(a.stock) - num(b.stock) || text(a.product).localeCompare(text(b.product)),
        )
        .map((p) => ({
          product: p.product,
          status: p.stockStatus,
          stock: p.stock,
          reorderLevel: p.reorderLevel,
        }));
      return {
        outOfStock: rows.filter((r) => r.status === 'Out of stock').length,
        lowStock: rows.filter((r) => r.status === 'Low stock').length,
        ...listed(rows),
      };
    },

    topProducts(range: DateRange = {}, limit = 10) {
      const rows = dataset.orderItems.filter(
        (i) => num(i.soldAmount) > 0 && inRange(i.paidOn, range),
      );
      return {
        currency,
        note: 'Line totals of paid orders, excluding shipping. "count" is units sold.',
        rows: ranked(
          rows,
          (i) => text(i.product),
          (i) => num(i.soldAmount),
          (i) => num(i.soldUnits),
          limit,
        ),
      };
    },

    topCustomers(range: DateRange = {}, limit = 10) {
      const rows = dataset.payments.filter((p) => num(p.net) > 0 && inRange(p.paidOn, range));
      return {
        currency,
        note: 'Net revenue. "count" is completed orders.',
        rows: ranked(
          rows,
          (p) => text(p.customer),
          (p) => num(p.net),
          (p) => num(p.paidOrders),
          limit,
        ),
      };
    },

    revenueByChannel(range: DateRange = {}) {
      const rows = dataset.payments.filter((p) => num(p.net) > 0 && inRange(p.paidOn, range));
      return {
        currency,
        note: 'Net revenue by channel (WhatsApp voice, WhatsApp text, website, Agent console).',
        rows: ranked(
          rows,
          (p) => text(p.source),
          (p) => num(p.net),
          (p) => num(p.paidOrders),
          20,
        ),
      };
    },

    salesBetween(range: DateRange) {
      const rows = dataset.payments.filter((p) => num(p.gross) > 0 && inRange(p.paidOn, range));
      const sum = (key: string) => rows.reduce((total, p) => total + num(p[key]), 0);
      const completed = sum('paidOrders');
      return {
        currency,
        from: range.from ?? null,
        to: range.to ?? null,
        grossSales: money(sum('gross')),
        refunds: money(sum('refunded')),
        netRevenue: money(sum('net')),
        completedOrders: completed,
      };
    },
  };
}
