import { formatMoney, isPayPalSupportedCurrency, toMinorUnits } from './money';

export interface PaymentPolicyConfig {
  /** Maximum single payment request, in major units of the request currency. */
  maxPaymentRequestAmount: number;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Guardrails evaluated before a payment request is proposed AND again before it executes.
 * Pure function — easy to unit test and to extend (per-merchant limits, velocity checks, ...).
 */
export function evaluatePaymentRequest(
  request: { totalMinor: number; currency: string },
  config: PaymentPolicyConfig,
): PolicyDecision {
  if (request.totalMinor <= 0)
    return { allowed: false, reason: 'The amount must be greater than zero.' };
  if (!isPayPalSupportedCurrency(request.currency)) {
    return {
      allowed: false,
      reason: `PayPal does not support ${request.currency}. Please use a supported currency such as USD.`,
    };
  }
  // Limit is configured in major units; convert deterministically (rounding down to whole units).
  const limitMinor = toMinorUnits(Math.floor(config.maxPaymentRequestAmount), request.currency);
  if (request.totalMinor > limitMinor) {
    return {
      allowed: false,
      reason: `Payment requests above ${formatMoney(limitMinor, request.currency)} are not allowed.`,
    };
  }
  return { allowed: true };
}
