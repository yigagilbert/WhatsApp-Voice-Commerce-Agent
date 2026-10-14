import { ValidationError } from '@vca/shared';

/**
 * Money is represented as an integer number of MINOR units (e.g. cents) plus an
 * ISO-4217 currency code. All conversions are string-based so binary floating point
 * never touches financial values.
 */

/** Currencies with no minor unit (in PayPal's and/or ISO's view). Everything else uses 2. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY',
  'HUF',
  'TWD',
  'KRW',
  'UGX',
  'RWF',
  'XAF',
  'XOF',
  'VND',
  'CLP',
  'ISK',
]);

/**
 * Currencies PayPal accepts for payments. Notably NOT UGX/KES/NGN — merchants in those
 * markets must invoice in a supported currency (e.g. USD). See docs/architecture/paypal-integration.md.
 */
export const PAYPAL_SUPPORTED_CURRENCIES = new Set([
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MYR',
  'MXN',
  'TWD',
  'NZD',
  'NOK',
  'PHP',
  'PLN',
  'GBP',
  'SGD',
  'SEK',
  'CHF',
  'THB',
  'USD',
]);

/** Largest amount (in minor units) we accept anywhere — guards against overflow and typos. */
export const MAX_MINOR_AMOUNT = 1_000_000_000;

export function normalizeCurrency(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) throw new ValidationError(`Invalid currency code '${code}'`);
  return upper;
}

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currency)) ? 0 : 2;
}

/** Plain decimal string for a JS number, without exponent notation. */
function toPlainDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new ValidationError(`Amount must be a finite number`);
  // Up to 20 fraction digits is enough to detect excess precision; trim trailing zeros.
  const fixed = value.toFixed(20).replace(/\.?0+$/, '');
  // toFixed(20) can expose float noise (12.1 -> 12.0999...). Prefer the shortest repr when it is plain.
  const shortest = String(value);
  return /e/i.test(shortest) ? fixed : shortest;
}

/**
 * Converts a major-unit amount ("12.50", 12.5) to minor units (1250).
 * Rejects negative values and more precision than the currency allows — we never round silently.
 */
export function toMinorUnits(amount: number | string, currency: string): number {
  const exponent = currencyExponent(currency);
  const text = typeof amount === 'number' ? toPlainDecimalString(amount) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new ValidationError(`Invalid amount '${String(amount)}'`);
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > exponent) {
    throw new ValidationError(
      `Amount '${text}' has more decimal places than ${normalizeCurrency(currency)} allows (${exponent})`,
    );
  }
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_AMOUNT) {
    throw new ValidationError(`Amount '${text}' is too large`);
  }
  return minor;
}

/** Minor units -> fixed decimal string in major units, as PayPal expects ("680.00"). */
export function toMajorString(minor: number, currency: string): string {
  assertMinorAmount(minor);
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, '0');
  return `${sign}${abs.slice(0, -exponent)}.${abs.slice(-exponent)}`;
}

/** Human-friendly formatting, e.g. "$680.00" or "UGX 50,000". */
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const code = normalizeCurrency(currency);
  const exponent = currencyExponent(code);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Number(toMajorString(minor, code)));
}

export function assertMinorAmount(minor: number): void {
  if (!Number.isSafeInteger(minor))
    throw new ValidationError(`Amount must be an integer number of minor units`);
}

export const isPayPalSupportedCurrency = (currency: string): boolean =>
  PAYPAL_SUPPORTED_CURRENCIES.has(normalizeCurrency(currency));
