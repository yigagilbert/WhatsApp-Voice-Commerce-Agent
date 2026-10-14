import { formatMoney } from './money';

/**
 * Deterministic business aggregations over paid orders. Pure functions so they are unit-tested
 * without a database; the services load the facts, these do the arithmetic. The LLM only ever
 * sees the results.
 */

export type InputMode = 'TEXT' | 'VOICE';

/** One paid order: a COMPLETED payment and the order it paid for. */
export interface PaidOrderFact {
  reference: string;
  customerId: string;
  customerName: string;
  /** Channel the order came from ("whatsapp", "web"). */
  source: string;
  inputMode: InputMode;
  currency: string;
  /** Amount PayPal captured (order total incl. shipping and tax). */
  amountMinor: number;
  items: { description: string; quantity: number; lineTotalMinor: number }[];
}

export interface MoneyFigure {
  currency: string;
  amountMinor: number;
  /** Pre-formatted so nobody downstream formats or adds money. */
  formatted: string;
}

const figure = (currency: string, amountMinor: number): MoneyFigure => ({
  currency,
  amountMinor,
  formatted: formatMoney(amountMinor, currency),
});

/** "WhatsApp voice", "WhatsApp text", "Agent console". */
export function sourceLabel(source: string, inputMode: InputMode): string {
  if (source === 'web') return inputMode === 'VOICE' ? 'Agent console voice' : 'Agent console';
  const channel = source === 'whatsapp' ? 'WhatsApp' : source;
  return `${channel} ${inputMode === 'VOICE' ? 'voice' : 'text'}`;
}

const sumBy = <T>(rows: T[], key: (row: T) => string, value: (row: T) => number) => {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + value(row));
  return totals;
};

/** Sorted by amount (desc), then by name, so ties are stable. */
const byAmount = <T extends { amountMinor: number; name: string }>(a: T, b: T) =>
  b.amountMinor - a.amountMinor || a.name.localeCompare(b.name);

export interface SalesBreakdown {
  paidOrders: number;
  averageOrderValue: MoneyFigure[];
  /** Product revenue = line totals of paid orders (excludes shipping and tax). */
  topProducts: (MoneyFigure & { name: string; quantity: number; sharePercent: number })[];
  topCustomers: (MoneyFigure & { name: string; orders: number })[];
  bySource: (MoneyFigure & { name: string; orders: number })[];
}

export function aggregatePaidOrders(facts: PaidOrderFact[], limit = 5): SalesBreakdown {
  const currencies = [...new Set(facts.map((f) => f.currency))].sort();

  const averageOrderValue = currencies.map((currency) => {
    const rows = facts.filter((f) => f.currency === currency);
    const total = rows.reduce((sum, f) => sum + f.amountMinor, 0);
    return figure(currency, Math.round(total / rows.length));
  });

  const lines = facts.flatMap((f) => f.items.map((item) => ({ ...item, currency: f.currency })));
  const productKey = (l: { description: string; currency: string }) =>
    `${l.currency}\u0000${l.description}`;
  const productRevenue = sumBy(lines, productKey, (l) => l.lineTotalMinor);
  const productQuantity = sumBy(lines, productKey, (l) => l.quantity);
  const lineTotalByCurrency = sumBy(
    lines,
    (l) => l.currency,
    (l) => l.lineTotalMinor,
  );
  const topProducts = [...productRevenue.entries()]
    .map(([key, amountMinor]) => {
      const [currency = '', name = ''] = key.split('\u0000');
      const all = lineTotalByCurrency.get(currency) ?? 0;
      return {
        ...figure(currency, amountMinor),
        name,
        quantity: productQuantity.get(key) ?? 0,
        sharePercent: all > 0 ? Math.round((amountMinor / all) * 1000) / 10 : 0,
      };
    })
    .sort(byAmount)
    .slice(0, limit);

  const customerKey = (f: PaidOrderFact) => `${f.currency}\u0000${f.customerId}`;
  const customerRevenue = sumBy(facts, customerKey, (f) => f.amountMinor);
  const customerOrders = sumBy(facts, customerKey, () => 1);
  const customerNames = new Map(facts.map((f) => [customerKey(f), f.customerName]));
  const topCustomers = [...customerRevenue.entries()]
    .map(([key, amountMinor]) => ({
      ...figure(key.split('\u0000')[0] ?? '', amountMinor),
      name: customerNames.get(key) ?? '',
      orders: customerOrders.get(key) ?? 0,
    }))
    .sort(byAmount)
    .slice(0, limit);

  const sourceKey = (f: PaidOrderFact) =>
    `${f.currency}\u0000${sourceLabel(f.source, f.inputMode)}`;
  const sourceRevenue = sumBy(facts, sourceKey, (f) => f.amountMinor);
  const sourceOrders = sumBy(facts, sourceKey, () => 1);
  const bySource = [...sourceRevenue.entries()]
    .map(([key, amountMinor]) => {
      const [currency = '', name = ''] = key.split('\u0000');
      return { ...figure(currency, amountMinor), name, orders: sourceOrders.get(key) ?? 0 };
    })
    .sort(byAmount);

  return { paidOrders: facts.length, averageOrderValue, topProducts, topCustomers, bySource };
}
