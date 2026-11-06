import { describe, expect, it } from 'vitest';
import { checkReplyPrices, moneyAmounts } from './price-guard';

describe('price guard', () => {
  it('reads the formats the audit found it missed', () => {
    expect(moneyAmounts('USh 50,000', 'UGX')).toEqual([50_000]);
    expect(moneyAmounts('50,000 shs', 'UGX')).toEqual([50_000]);
    expect(moneyAmounts('I can do 50k', 'UGX')).toEqual([50_000]);
  });

  it.each([
    ['You can have 10% off', 'percent'],
    ['ten percent off for you', 'percent'],
    ['I can give you free delivery', 'free'],
    ['That is €28', 'foreign_currency'],
    ['That is KES 28', 'foreign_currency'],
    ['Fifty thousand shillings only', 'amount_in_words'],
  ])('flags "%s" in a USD shop', (reply, promise) => {
    const check = checkReplyPrices({
      reply,
      currency: 'USD',
      allowedMinor: [2800],
      requiredMinor: null,
    });
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.promises).toContain(promise);
  });

  it('allows a percentage or free delivery the backend itself stated', () => {
    expect(
      checkReplyPrices({
        reply: 'Buy 3 and get 10% off, with free delivery.',
        currency: 'USD',
        allowedMinor: [],
        requiredMinor: null,
        backendText: '{"quantity_deals":"10% off from 3","note":"free delivery on all orders"}',
      }).ok,
    ).toBe(true);
  });

  it('does not count ordinary numbers or a real local price', () => {
    expect(
      checkReplyPrices({
        reply: 'That is UGX 50,000, and we have 2 colours. It is 100 percent cotton',
        currency: 'UGX',
        allowedMinor: [50_000],
        requiredMinor: null,
        backendText: 'made of 100 percent cotton',
      }).ok,
    ).toBe(true);
  });

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
    ).toEqual({ ok: false, unexpected: [100], missing: 2900, promises: [] });
  });
});
