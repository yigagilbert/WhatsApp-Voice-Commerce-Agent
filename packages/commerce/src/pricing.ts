import { ValidationError } from '@vca/shared';
import { MAX_MINOR_AMOUNT, assertMinorAmount, normalizeCurrency } from './money';

export const MAX_LINE_QUANTITY = 100_000;
export const MAX_ORDER_LINES = 50;

export interface PricingLineInput {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  productId?: string | null;
}

export interface PricedLine extends PricingLineInput {
  lineTotalMinor: number;
}

export interface OrderTotals {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
}

function checkedAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > MAX_MINOR_AMOUNT) {
    throw new ValidationError('Order total exceeds the maximum supported amount');
  }
  return sum;
}

/**
 * The ONLY place order totals are computed. Deterministic integer arithmetic;
 * any total suggested by the AI is ignored in favour of this result.
 */
export function calculateOrderTotals(input: {
  currency: string;
  lines: PricingLineInput[];
  shippingMinor?: number;
  taxMinor?: number;
}): OrderTotals {
  const currency = normalizeCurrency(input.currency);
  if (input.lines.length === 0) throw new ValidationError('An order needs at least one item');
  if (input.lines.length > MAX_ORDER_LINES) {
    throw new ValidationError(`An order can have at most ${MAX_ORDER_LINES} items`);
  }

  const lines = input.lines.map((line, index): PricedLine => {
    if (!line.description.trim()) throw new ValidationError(`Item ${index + 1} has no description`);
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > MAX_LINE_QUANTITY
    ) {
      throw new ValidationError(
        `Item '${line.description}': quantity must be a whole number between 1 and ${MAX_LINE_QUANTITY}`,
      );
    }
    assertMinorAmount(line.unitPriceMinor);
    if (line.unitPriceMinor < 0) {
      throw new ValidationError(`Item '${line.description}': unit price cannot be negative`);
    }
    const lineTotalMinor = line.unitPriceMinor * line.quantity;
    if (!Number.isSafeInteger(lineTotalMinor) || lineTotalMinor > MAX_MINOR_AMOUNT) {
      throw new ValidationError(`Item '${line.description}': line total is too large`);
    }
    return { ...line, lineTotalMinor };
  });

  const shippingMinor = input.shippingMinor ?? 0;
  const taxMinor = input.taxMinor ?? 0;
  for (const [label, value] of [
    ['Shipping', shippingMinor],
    ['Tax', taxMinor],
  ] as const) {
    assertMinorAmount(value);
    if (value < 0) throw new ValidationError(`${label} cannot be negative`);
  }

  const subtotalMinor = lines.reduce((sum, line) => checkedAdd(sum, line.lineTotalMinor), 0);
  const totalMinor = checkedAdd(checkedAdd(subtotalMinor, shippingMinor), taxMinor);
  if (totalMinor <= 0) throw new ValidationError('Order total must be greater than zero');

  return { currency, lines, subtotalMinor, shippingMinor, taxMinor, totalMinor };
}
