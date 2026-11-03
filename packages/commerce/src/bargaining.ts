// Errors only (not the package index): this module is also bundled into dashboard client code.
import { ValidationError } from '@vca/shared/errors';
import { MAX_MINOR_AMOUNT } from './money';

/**
 * Smart pricing and bargaining. Pure, deterministic integer arithmetic on minor units: the
 * merchant's rules go in, a unit price comes out. The AI never computes a price; it only relays
 * what these functions decide, and the backend re-applies them to every cart and checkout.
 *
 * - Quantity discounts: per product, "buy N or more, X% off each" (up to 3 tiers).
 * - Bundle discount: per merchant, "N or more different bargainable products together, X% off".
 * - Bargaining: per product, a counter-offer ladder from the automatic price down towards the
 *   merchant's minimum, in at most MAX_COUNTER_OFFERS steps. Discounts never stack: a line gets
 *   the single best price it qualifies for, and never less than the minimum.
 */

// A type (not an interface) so tiers can be stored as JSON as they are.
export type QuantityTier = {
  minQuantity: number;
  percentOff: number;
};

export interface PricingRules {
  unitPriceMinor: number;
  bargainingEnabled: boolean;
  /** Lowest unit price the merchant accepts (required to bargain). Never shown to customers. */
  minPriceMinor: number | null;
  quantityDiscounts: QuantityTier[];
}

export interface BundleRule {
  minItems: number;
  percentOff: number;
}

export type AutomaticPricing = 'LIST' | 'QUANTITY' | 'BUNDLE';

export const MAX_QUANTITY_TIERS = 3;
export const MAX_PERCENT_OFF = 90;
/** Shop counter-offers per product per customer within the bargaining window. */
export const MAX_COUNTER_OFFERS = 3;
/** Share of the room (automatic price → minimum) conceded at each counter-offer, in percent. */
const CONCESSION_PERCENT = [30, 60, 85] as const;

/** Parses stored tiers (JSON) defensively; anything malformed is ignored, never trusted. */
export function parseQuantityTiers(value: unknown): QuantityTier[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is QuantityTier =>
        !!t &&
        typeof t === 'object' &&
        Number.isInteger((t as QuantityTier).minQuantity) &&
        Number.isInteger((t as QuantityTier).percentOff) &&
        (t as QuantityTier).minQuantity >= 2 &&
        (t as QuantityTier).percentOff >= 1 &&
        (t as QuantityTier).percentOff <= MAX_PERCENT_OFF,
    )
    .map((t) => ({ minQuantity: t.minQuantity, percentOff: t.percentOff }))
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .slice(0, MAX_QUANTITY_TIERS);
}

/** Checks a product's pricing rules; throws a merchant-friendly ValidationError. */
export function validatePricingRules(rules: PricingRules): void {
  const { unitPriceMinor: price, minPriceMinor: min } = rules;
  if (min !== null) {
    if (!Number.isSafeInteger(min) || min <= 0 || min > MAX_MINOR_AMOUNT)
      throw new ValidationError('Enter a lowest price greater than zero, such as 20 or 20.50.');
    if (min > price)
      throw new ValidationError('The lowest price you accept cannot be above the selling price.');
  }
  if (rules.bargainingEnabled && min === null)
    throw new ValidationError('Set the lowest price you accept before allowing bargaining.');
  const tiers = rules.quantityDiscounts;
  if (tiers.length > MAX_QUANTITY_TIERS)
    throw new ValidationError(`Use at most ${MAX_QUANTITY_TIERS} quantity discounts.`);
  let previous: QuantityTier | null = null;
  for (const tier of [...tiers].sort((a, b) => a.minQuantity - b.minQuantity)) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 2 || tier.minQuantity > 1000)
      throw new ValidationError('Quantity discounts start at 2 units or more (up to 1000).');
    if (
      !Number.isInteger(tier.percentOff) ||
      tier.percentOff < 1 ||
      tier.percentOff > MAX_PERCENT_OFF
    )
      throw new ValidationError(
        `A quantity discount must be a whole percentage from 1 to ${MAX_PERCENT_OFF}.`,
      );
    if (previous && tier.minQuantity === previous.minQuantity)
      throw new ValidationError('Each quantity discount needs a different quantity.');
    if (previous && tier.percentOff <= previous.percentOff)
      throw new ValidationError('Larger quantities should get a larger discount.');
    previous = tier;
  }
}

export function validateBundleRule(rule: BundleRule | null): void {
  if (!rule) return;
  if (!Number.isInteger(rule.minItems) || rule.minItems < 2 || rule.minItems > 20)
    throw new ValidationError('A bundle needs 2 to 20 different products.');
  if (
    !Number.isInteger(rule.percentOff) ||
    rule.percentOff < 1 ||
    rule.percentOff > MAX_PERCENT_OFF
  )
    throw new ValidationError(
      `The bundle discount must be a whole percentage from 1 to ${MAX_PERCENT_OFF}.`,
    );
}

/** `percent` off a unit price, rounded in the merchant's favour (never below the minimum). */
function discounted(rules: PricingRules, percent: number): number {
  const price = Math.ceil((rules.unitPriceMinor * (100 - percent)) / 100);
  return Math.max(price, rules.minPriceMinor ?? 0);
}

/** The best quantity tier for `quantity`, if any. */
export function quantityTier(rules: PricingRules, quantity: number): QuantityTier | null {
  return (
    [...rules.quantityDiscounts]
      .sort((a, b) => b.minQuantity - a.minQuantity)
      .find((t) => quantity >= t.minQuantity) ?? null
  );
}

/** Whether a cart qualifies for the bundle discount: enough different bargainable products. */
export function bundleQualifies(
  rule: BundleRule | null,
  lines: { productId: string; bargainingEnabled: boolean }[],
): boolean {
  if (!rule) return false;
  return (
    new Set(lines.filter((l) => l.bargainingEnabled).map((l) => l.productId)).size >= rule.minItems
  );
}

/**
 * The price a line gets without bargaining: the regular price, or the single best quantity or
 * bundle discount it qualifies for (they never stack). Bundles apply to bargainable products only.
 */
export function automaticUnitPrice(
  rules: PricingRules,
  quantity: number,
  bundle: BundleRule | null,
): { unitMinor: number; pricing: AutomaticPricing; percentOff: number } {
  const tierPercent = quantityTier(rules, quantity)?.percentOff ?? 0;
  const bundlePercent = bundle && rules.bargainingEnabled ? bundle.percentOff : 0;
  const percent = Math.max(tierPercent, bundlePercent);
  if (percent === 0) return { unitMinor: rules.unitPriceMinor, pricing: 'LIST', percentOff: 0 };
  const unitMinor = discounted(rules, percent);
  if (unitMinor >= rules.unitPriceMinor)
    return { unitMinor: rules.unitPriceMinor, pricing: 'LIST', percentOff: 0 };
  return {
    unitMinor,
    pricing: tierPercent >= bundlePercent ? 'QUANTITY' : 'BUNDLE',
    percentOff: percent,
  };
}

/**
 * A "round" price step for offers ($1 on a $30 bag, UGX 5,000 on UGX 120,000), small enough
 * that the bargaining room still holds about three steps.
 */
export function offerStep(unitMinor: number, roomMinor: number): number {
  // Candidate steps from coarse to fine: 10^k, 5·10^(k-1), 10^(k-1), … 1.
  let power = 10 ** Math.max(0, String(Math.trunc(unitMinor)).length - 2);
  while (power >= 1) {
    if (power <= roomMinor / 3) return power;
    if (power >= 10 && power / 2 <= roomMinor / 3) return power / 2;
    power /= 10;
  }
  return 1;
}

/** The shop's k-th counter-offer (1-based): a round number between the base and the minimum. */
export function counterOffer(baseMinor: number, floorMinor: number, round: number): number {
  const room = baseMinor - floorMinor;
  if (room <= 0) return baseMinor;
  const percent = CONCESSION_PERCENT[Math.min(round, CONCESSION_PERCENT.length) - 1]!;
  const raw = baseMinor - Math.floor((room * percent) / 100);
  // Round up to the coarsest step that still leaves a real concession ($26.50, not $27 = no
  // discount); fall back to the exact figure on tiny margins.
  const steps: number[] = [];
  for (let s = offerStep(baseMinor, room); s >= 1; s /= 10) steps.push(s, s / 2);
  const step = steps.filter(Number.isInteger).find((s) => Math.ceil(raw / s) * s < baseMinor);
  const offer = step ? Math.ceil(raw / step) * step : raw;
  return Math.min(baseMinor, Math.max(floorMinor, offer));
}

export type NegotiationDecision =
  /** The shop offers a new, lower unit price. `final` = no further concessions. */
  | { kind: 'counter'; offerUnitMinor: number; round: number; final: boolean }
  /** The customer's price (or a better one for them) is agreed. */
  | { kind: 'accept'; unitMinor: number }
  /** Out of concessions: the standing offer is the best price. */
  | { kind: 'final'; offerUnitMinor: number }
  /** Nothing to bargain: the automatic price is already at the minimum. */
  | { kind: 'best_price'; unitMinor: number };

/**
 * One bargaining move. `base` is the automatic price for the quantity, `floor` the merchant's
 * minimum, `round` how many counter-offers the shop already made, `standing` its current offer
 * for this quantity (if any) and `customer` the unit price the customer proposed (if any).
 *
 * Guarantees: every price returned is ≥ floor and ≤ base, offers only go down, the customer is
 * never charged more than they offered once agreed, and the floor is never revealed directly
 * (counter-offers stop short of it unless rounding lands there).
 */
export function negotiate(input: {
  baseUnitMinor: number;
  floorMinor: number;
  round: number;
  standingOfferMinor: number | null;
  customerUnitMinor: number | null;
}): NegotiationDecision {
  const { baseUnitMinor: base, floorMinor: floor, round } = input;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(floor) || floor <= 0)
    throw new ValidationError('Invalid pricing rules');
  if (base <= floor) return { kind: 'best_price', unitMinor: base };
  const standing = Math.min(input.standingOfferMinor ?? base, base);
  const customer = input.customerUnitMinor;

  if (customer !== null) {
    if (!Number.isSafeInteger(customer) || customer <= 0)
      return round >= MAX_COUNTER_OFFERS
        ? { kind: 'final', offerUnitMinor: standing }
        : nextCounter(base, floor, round, standing);
    // Already at or above what we offered: agree at the lower of the two (never overcharge).
    if (customer >= standing) return { kind: 'accept', unitMinor: standing };
    if (round < MAX_COUNTER_OFFERS) {
      const next = Math.min(counterOffer(base, floor, round + 1), standing);
      if (customer >= next && customer >= floor) return { kind: 'accept', unitMinor: customer };
    }
  }
  if (round >= MAX_COUNTER_OFFERS) return { kind: 'final', offerUnitMinor: standing };
  return nextCounter(base, floor, round, standing);
}

function nextCounter(
  base: number,
  floor: number,
  round: number,
  standing: number,
): NegotiationDecision {
  const next = Math.min(counterOffer(base, floor, round + 1), standing);
  if (next >= standing && round > 0) return { kind: 'final', offerUnitMinor: standing };
  return {
    kind: 'counter',
    offerUnitMinor: next,
    round: round + 1,
    final: round + 1 >= MAX_COUNTER_OFFERS || next <= floor,
  };
}

/** Unit price for "X for N" offers, rounded up in the merchant's favour. */
export const unitFromTotal = (totalMinor: number, quantity: number): number =>
  Math.ceil(totalMinor / quantity);
