import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  isPayPalSupportedCurrency,
  toMajorNumber,
  toMajorString,
  toMinorUnits,
} from './money';

describe('toMinorUnits', () => {
  it('converts major units to integer minor units without float error', () => {
    expect(toMinorUnits(12, 'USD')).toBe(1200);
    expect(toMinorUnits(0.1, 'USD')).toBe(10);
    expect(toMinorUnits(1.005 * 0 + 19.99, 'USD')).toBe(1999);
    expect(toMinorUnits('80.5', 'usd')).toBe(8050);
    expect(toMinorUnits(50000, 'UGX')).toBe(50000);
  });

  it('rejects more precision than the currency allows instead of rounding', () => {
    expect(() => toMinorUnits(12.345, 'USD')).toThrow(/decimal places/);
    expect(() => toMinorUnits(100.5, 'JPY')).toThrow(/decimal places/);
  });

  it('rejects negative, non-numeric and absurdly large amounts', () => {
    expect(() => toMinorUnits(-1, 'USD')).toThrow();
    expect(() => toMinorUnits('12abc', 'USD')).toThrow();
    expect(() => toMinorUnits(Number.NaN, 'USD')).toThrow();
    expect(() => toMinorUnits(1e15, 'USD')).toThrow(/too large/);
  });
});

describe('formatting', () => {
  it('produces PayPal decimal strings', () => {
    expect(toMajorString(68000, 'USD')).toBe('680.00');
    expect(toMajorString(5, 'USD')).toBe('0.05');
    expect(toMajorString(1500, 'JPY')).toBe('1500');
  });

  it('formats for humans', () => {
    expect(formatMoney(68000, 'USD')).toBe('$680.00');
  });

  it('knows which currencies PayPal supports', () => {
    expect(isPayPalSupportedCurrency('USD')).toBe(true);
    expect(isPayPalSupportedCurrency('UGX')).toBe(false);
  });
});

describe('toMajorNumber', () => {
  it('divides only currencies that have a minor unit', () => {
    expect(toMajorNumber(2450, 'USD')).toBe(24.5);
    expect(toMajorNumber(50_000, 'UGX')).toBe(50_000);
    expect(toMajorNumber(1500, 'JPY')).toBe(1500);
    expect(formatMoney(50_000, 'UGX')).toMatch(/^UGX\s50,000$/);
  });
});
