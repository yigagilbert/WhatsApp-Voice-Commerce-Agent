import { describe, expect, it } from 'vitest';
import {
  MAX_COUNTER_OFFERS,
  automaticUnitPrice,
  bundleQualifies,
  counterOffer,
  negotiate,
  offerStep,
  parseQuantityTiers,
  unitFromTotal,
  validateBundleRule,
  validatePricingRules,
  type PricingRules,
} from './bargaining';

const bag: PricingRules = {
  unitPriceMinor: 3000,
  bargainingEnabled: true,
  minPriceMinor: 2400,
  quantityDiscounts: [
    { minQuantity: 3, percentOff: 5 },
    { minQuantity: 5, percentOff: 10 },
  ],
};
const fixed: PricingRules = { ...bag, bargainingEnabled: false, minPriceMinor: null };

describe('pricing rules', () => {
  it('accepts sensible rules', () => {
    expect(() => validatePricingRules(bag)).not.toThrow();
    expect(() => validatePricingRules(fixed)).not.toThrow();
  });

  it.each([
    [{ ...bag, minPriceMinor: 3100 }, /cannot be above the selling price/],
    [{ ...bag, minPriceMinor: 0 }, /greater than zero/],
    [{ ...bag, minPriceMinor: null }, /Set the lowest price/],
    [{ ...bag, quantityDiscounts: [{ minQuantity: 1, percentOff: 5 }] }, /2 units or more/],
    [{ ...bag, quantityDiscounts: [{ minQuantity: 3, percentOff: 95 }] }, /1 to 90/],
    [
      {
        ...bag,
        quantityDiscounts: [
          { minQuantity: 3, percentOff: 10 },
          { minQuantity: 5, percentOff: 5 },
        ],
      },
      /larger discount/,
    ],
  ])('rejects %#', (rules, error) => {
    expect(() => validatePricingRules(rules)).toThrow(error);
  });

  it('parses stored tiers defensively', () => {
    expect(
      parseQuantityTiers([
        { minQuantity: 5, percentOff: 10 },
        { minQuantity: 'x', percentOff: 10 },
        { minQuantity: 3, percentOff: 500 },
        null,
        { minQuantity: 3, percentOff: 5 },
      ]),
    ).toEqual([
      { minQuantity: 3, percentOff: 5 },
      { minQuantity: 5, percentOff: 10 },
    ]);
    expect(parseQuantityTiers('nonsense')).toEqual([]);
  });

  it('validates bundle rules', () => {
    expect(() => validateBundleRule({ minItems: 2, percentOff: 10 })).not.toThrow();
    expect(() => validateBundleRule({ minItems: 1, percentOff: 10 })).toThrow(/2 to 20/);
    expect(() => validateBundleRule({ minItems: 2, percentOff: 0 })).toThrow(/percentage/);
  });
});

describe('automatic prices (quantity and bundle discounts)', () => {
  it('uses the regular price for small quantities', () => {
    expect(automaticUnitPrice(bag, 1, null)).toEqual({
      unitMinor: 3000,
      pricing: 'LIST',
      percentOff: 0,
    });
  });

  it('applies the best quantity tier', () => {
    expect(automaticUnitPrice(bag, 3, null)).toMatchObject({
      unitMinor: 2850,
      pricing: 'QUANTITY',
    });
    expect(automaticUnitPrice(bag, 7, null)).toMatchObject({
      unitMinor: 2700,
      pricing: 'QUANTITY',
    });
  });

  it('never stacks quantity and bundle discounts: the larger one wins', () => {
    const bundle = { minItems: 2, percentOff: 8 };
    expect(automaticUnitPrice(bag, 1, bundle)).toMatchObject({
      unitMinor: 2760,
      pricing: 'BUNDLE',
    });
    expect(automaticUnitPrice(bag, 5, bundle)).toMatchObject({
      unitMinor: 2700,
      pricing: 'QUANTITY',
      percentOff: 10,
    });
  });

  it('gives bundles to bargainable products only', () => {
    expect(automaticUnitPrice(fixed, 1, { minItems: 2, percentOff: 8 }).pricing).toBe('LIST');
  });

  it('never goes below the merchant minimum', () => {
    const steep = { ...bag, quantityDiscounts: [{ minQuantity: 2, percentOff: 50 }] };
    expect(automaticUnitPrice(steep, 2, null).unitMinor).toBe(2400);
  });

  it('rounds discounted prices up, in the merchant’s favour', () => {
    const odd = {
      ...fixed,
      unitPriceMinor: 999,
      quantityDiscounts: [{ minQuantity: 2, percentOff: 15 }],
    };
    expect(automaticUnitPrice(odd, 2, null).unitMinor).toBe(850); // 849.15 → 850
  });

  it('counts different bargainable products for the bundle', () => {
    const rule = { minItems: 2, percentOff: 5 };
    expect(bundleQualifies(rule, [{ productId: 'a', bargainingEnabled: true }])).toBe(false);
    expect(
      bundleQualifies(rule, [
        { productId: 'a', bargainingEnabled: true },
        { productId: 'b', bargainingEnabled: false },
      ]),
    ).toBe(false);
    expect(
      bundleQualifies(rule, [
        { productId: 'a', bargainingEnabled: true },
        { productId: 'b', bargainingEnabled: true },
      ]),
    ).toBe(true);
  });
});

describe('counter-offers', () => {
  it('uses round steps', () => {
    expect(offerStep(3000, 600)).toBe(100);
    expect(offerStep(900, 200)).toBe(10);
    expect(offerStep(50_000, 10_000)).toBe(1000);
    expect(offerStep(120_000, 25_000)).toBe(5000);
    expect(offerStep(3000, 100)).toBe(10);
    expect(offerStep(80, 20)).toBe(1);
  });

  it('concedes in round numbers, within the range, towards the minimum', () => {
    const offers = [1, 2, 3].map((r) => counterOffer(3000, 2400, r));
    expect(offers).toEqual([2900, 2700, 2500]);
    for (const o of offers) {
      expect(o).toBeGreaterThanOrEqual(2400);
      expect(o).toBeLessThan(3000);
    }
  });

  it('works for zero-decimal currencies (UGX)', () => {
    expect([1, 2, 3].map((r) => counterOffer(120_000, 95_000, r))).toEqual([
      115_000, 105_000, 100_000,
    ]);
  });

  it('rounds to a finer step rather than erase the concession', () => {
    // 5+ bags: $27.00 base, $24.00 minimum → $26.50 (not $26.10, and not $27 = no discount).
    expect(counterOffer(2700, 2400, 1)).toBe(2650);
  });

  it('keeps a concession when rounding would erase it (tiny margins)', () => {
    const offer = counterOffer(1000, 990, 1);
    expect(offer).toBeLessThan(1000);
    expect(offer).toBeGreaterThanOrEqual(990);
  });
});

describe('negotiate', () => {
  const start = { baseUnitMinor: 3000, floorMinor: 2400, round: 0, standingOfferMinor: null };

  it('offers a first discount when asked for a better price', () => {
    expect(negotiate({ ...start, customerUnitMinor: null })).toEqual({
      kind: 'counter',
      offerUnitMinor: 2900,
      round: 1,
      final: false,
    });
  });

  it('counters a lowball offer without going below the minimum', () => {
    const decision = negotiate({ ...start, customerUnitMinor: 1000 });
    expect(decision).toMatchObject({ kind: 'counter', offerUnitMinor: 2900 });
  });

  it('accepts a reasonable customer price at or above the next counter-offer', () => {
    expect(
      negotiate({ ...start, round: 1, standingOfferMinor: 2900, customerUnitMinor: 2750 }),
    ).toEqual({ kind: 'accept', unitMinor: 2750 });
  });

  it('agrees at the standing offer when the customer offers more than it', () => {
    expect(
      negotiate({ ...start, round: 1, standingOfferMinor: 2900, customerUnitMinor: 2950 }),
    ).toEqual({ kind: 'accept', unitMinor: 2900 });
  });

  it('stops after the maximum number of counter-offers', () => {
    let standing: number | null = null;
    let round = 0;
    const offers: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = negotiate({
        ...start,
        round,
        standingOfferMinor: standing,
        customerUnitMinor: 2000,
      });
      if (d.kind === 'counter') {
        offers.push(d.offerUnitMinor);
        standing = d.offerUnitMinor;
        round = d.round;
      } else {
        expect(d).toEqual({ kind: 'final', offerUnitMinor: 2500 });
      }
    }
    expect(offers).toEqual([2900, 2700, 2500]);
    expect(round).toBe(MAX_COUNTER_OFFERS);
  });

  it('never returns a price below the minimum or above the base (exhaustive sweep)', () => {
    for (const base of [150, 999, 3000, 12_345, 120_000])
      for (const floor of [1, Math.floor(base / 2), base - 1])
        for (let round = 0; round <= MAX_COUNTER_OFFERS; round++)
          for (const customer of [null, 0, 1, floor - 1, floor, floor + 1, base, base * 2]) {
            const standing = round === 0 ? null : counterOffer(base, floor, round);
            const d = negotiate({
              baseUnitMinor: base,
              floorMinor: floor,
              round,
              standingOfferMinor: standing,
              customerUnitMinor: customer,
            });
            const price =
              d.kind === 'accept' || d.kind === 'best_price' ? d.unitMinor : d.offerUnitMinor;
            expect(price).toBeGreaterThanOrEqual(floor);
            expect(price).toBeLessThanOrEqual(base);
            if (d.kind === 'accept' && customer !== null)
              expect(price).toBeLessThanOrEqual(customer);
          }
  });

  it('has nothing to bargain when the price is already at the minimum', () => {
    expect(negotiate({ ...start, baseUnitMinor: 2400, customerUnitMinor: 2000 })).toEqual({
      kind: 'best_price',
      unitMinor: 2400,
    });
  });

  it('converts "X for N" into a unit price in the merchant’s favour', () => {
    expect(unitFromTotal(5001, 2)).toBe(2501);
  });
});
