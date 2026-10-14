import { describe, expect, it } from 'vitest';
import { aggregatePaidOrders, sourceLabel, type PaidOrderFact } from './insights';

const fact = (over: Partial<PaidOrderFact>): PaidOrderFact => ({
  reference: 'ORD-1',
  customerId: 'c_sarah',
  customerName: 'Sarah Thompson',
  source: 'whatsapp',
  inputMode: 'TEXT',
  currency: 'USD',
  amountMinor: 0,
  items: [],
  ...over,
});

const facts: PaidOrderFact[] = [
  // Voice: 10 baskets ($120) + $20 shipping = $140
  fact({
    reference: 'ORD-A',
    inputMode: 'VOICE',
    amountMinor: 14_000,
    items: [{ description: 'Handmade Basket', quantity: 10, lineTotalMinor: 12_000 }],
  }),
  // Text: 2 wallets ($36)
  fact({
    reference: 'ORD-B',
    customerId: 'c_james',
    customerName: 'James Carter',
    amountMinor: 3_600,
    items: [{ description: 'Barkcloth Wallet', quantity: 2, lineTotalMinor: 3_600 }],
  }),
  // Console: 1 basket + 1 coffee pack ($37)
  fact({
    reference: 'ORD-C',
    source: 'web',
    amountMinor: 3_700,
    items: [
      { description: 'Handmade Basket', quantity: 1, lineTotalMinor: 1_200 },
      { description: 'Coffee Gift Pack', quantity: 1, lineTotalMinor: 2_500 },
    ],
  }),
];

describe('aggregatePaidOrders', () => {
  const result = aggregatePaidOrders(facts);

  it('counts paid orders and computes the average order value in integer minor units', () => {
    expect(result.paidOrders).toBe(3);
    // (14000 + 3600 + 3700) / 3 = 7100
    expect(result.averageOrderValue).toEqual([
      { currency: 'USD', amountMinor: 7_100, formatted: '$71.00' },
    ]);
  });

  it('ranks products by revenue (line totals, no shipping) with quantity and share', () => {
    expect(
      result.topProducts.map((p) => [p.name, p.quantity, p.formatted, p.sharePercent]),
    ).toEqual([
      // 13200 / 19300 = 68.4 %
      ['Handmade Basket', 11, '$132.00', 68.4],
      ['Barkcloth Wallet', 2, '$36.00', 18.7],
      ['Coffee Gift Pack', 1, '$25.00', 13],
    ]);
  });

  it('ranks customers by paid amount', () => {
    expect(result.topCustomers.map((c) => [c.name, c.orders, c.formatted])).toEqual([
      ['Sarah Thompson', 2, '$177.00'],
      ['James Carter', 1, '$36.00'],
    ]);
  });

  it('splits revenue by source: WhatsApp voice vs text vs Agent console', () => {
    expect(result.bySource.map((s) => [s.name, s.orders, s.formatted])).toEqual([
      ['WhatsApp voice', 1, '$140.00'],
      ['Agent console', 1, '$37.00'],
      ['WhatsApp text', 1, '$36.00'],
    ]);
  });

  it('keeps currencies apart and handles no data', () => {
    const mixed = aggregatePaidOrders([
      fact({ amountMinor: 1_000 }),
      fact({ currency: 'EUR', amountMinor: 3_000 }),
    ]);
    expect(mixed.averageOrderValue.map((a) => a.formatted)).toEqual(['€30.00', '$10.00']);
    expect(aggregatePaidOrders([])).toEqual({
      paidOrders: 0,
      averageOrderValue: [],
      topProducts: [],
      topCustomers: [],
      bySource: [],
    });
  });
});

describe('sourceLabel', () => {
  it('names channels for people, not developers', () => {
    expect(sourceLabel('whatsapp', 'VOICE')).toBe('WhatsApp voice');
    expect(sourceLabel('whatsapp', 'TEXT')).toBe('WhatsApp text');
    expect(sourceLabel('web', 'TEXT')).toBe('Agent console');
  });
});
