import { describe, expect, it } from 'vitest';
import { checkReplyPrices, moneyAmounts } from './price-guard';

describe('price guard', () => {
  it('reads money amounts the way customers and models write them', () => {
    expect(moneyAmounts('I can do $28 or $27.50, regular US$ 30.00', 'USD').sort()).toEqual([
      2750, 2800, 3000,
    ]);
    expect(moneyAmounts('UGX 50,000 or 45,000/= or 40000 shillings', 'UGX').sort()).toEqual([
      40_000, 45_000, 50_000,
    ]);
    expect(moneyAmounts('Buy 3 and get 10% off, 2 left', 'USD')).toEqual([]);
  });

  it('passes replies that only state backend amounts and include the offer', () => {
    expect(
      checkReplyPrices({
        reply: "I can't do $20, but I can do $27.00 (regular $30).",
        currency: 'USD',
        allowedMinor: [2000, 2700, 3000],
        requiredMinor: 2700,
      }),
    ).toEqual({ ok: true });
  });

  it('flags invented amounts and a missing offer', () => {
    expect(
      checkReplyPrices({
        reply: 'Deal at $1!',
        currency: 'USD',
        allowedMinor: [2900, 3000],
        requiredMinor: 2900,
      }),
    ).toEqual({ ok: false, unexpected: [100], missing: 2900 });
  });
});
