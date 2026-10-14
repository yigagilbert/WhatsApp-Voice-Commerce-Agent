import { describe, expect, it } from 'vitest';
import { calculateOrderTotals } from './pricing';

describe('calculateOrderTotals', () => {
  it('computes the demo order deterministically: 50 × $12 + $80 shipping = $680', () => {
    const totals = calculateOrderTotals({
      currency: 'usd',
      lines: [{ description: 'Handmade Basket', quantity: 50, unitPriceMinor: 1200 }],
      shippingMinor: 8000,
    });
    expect(totals).toMatchObject({
      currency: 'USD',
      subtotalMinor: 60000,
      shippingMinor: 8000,
      taxMinor: 0,
      totalMinor: 68000,
    });
    expect(totals.lines[0]?.lineTotalMinor).toBe(60000);
  });

  it('sums multiple lines and tax', () => {
    const totals = calculateOrderTotals({
      currency: 'USD',
      lines: [
        { description: 'Wallet', quantity: 2, unitPriceMinor: 1800 },
        { description: 'Coffee', quantity: 3, unitPriceMinor: 2500 },
      ],
      taxMinor: 111,
    });
    expect(totals.subtotalMinor).toBe(11100);
    expect(totals.totalMinor).toBe(11211);
  });

  it.each([
    [{ quantity: 0, unitPriceMinor: 100 }, /quantity/],
    [{ quantity: 1.5, unitPriceMinor: 100 }, /quantity/],
    [{ quantity: 1, unitPriceMinor: -5 }, /negative/],
    [{ quantity: 1, unitPriceMinor: 10.5 }, /integer/],
  ])('rejects invalid line %o', (line, error) => {
    expect(() =>
      calculateOrderTotals({ currency: 'USD', lines: [{ description: 'x', ...line }] }),
    ).toThrow(error);
  });

  it('rejects empty orders, negative shipping and zero totals', () => {
    expect(() => calculateOrderTotals({ currency: 'USD', lines: [] })).toThrow(/at least one/);
    expect(() =>
      calculateOrderTotals({
        currency: 'USD',
        lines: [{ description: 'x', quantity: 1, unitPriceMinor: 1 }],
        shippingMinor: -1,
      }),
    ).toThrow(/Shipping/);
    expect(() =>
      calculateOrderTotals({
        currency: 'USD',
        lines: [{ description: 'x', quantity: 1, unitPriceMinor: 0 }],
      }),
    ).toThrow(/greater than zero/);
  });

  it('guards against overflow', () => {
    expect(() =>
      calculateOrderTotals({
        currency: 'USD',
        lines: [{ description: 'x', quantity: 100_000, unitPriceMinor: 900_000_000 }],
      }),
    ).toThrow(/too large/);
  });
});
