import { describe, expect, it } from 'vitest';
import { evaluatePaymentRequest } from './policy';
import { canTransitionOrder, canTransitionPayment, assertOrderTransition } from './state';

describe('evaluatePaymentRequest', () => {
  const config = { maxPaymentRequestAmount: 1000 };

  it('allows normal requests', () => {
    expect(evaluatePaymentRequest({ totalMinor: 68000, currency: 'USD' }, config)).toEqual({
      allowed: true,
    });
  });

  it('refuses amounts over the limit, unsupported currencies and zero', () => {
    expect(evaluatePaymentRequest({ totalMinor: 100001, currency: 'USD' }, config).allowed).toBe(
      false,
    );
    expect(evaluatePaymentRequest({ totalMinor: 5000, currency: 'UGX' }, config).allowed).toBe(
      false,
    );
    expect(evaluatePaymentRequest({ totalMinor: 0, currency: 'USD' }, config).allowed).toBe(false);
  });
});

describe('state machines', () => {
  it('only allows forward order transitions', () => {
    expect(canTransitionOrder('DRAFT', 'AWAITING_PAYMENT')).toBe(true);
    expect(canTransitionOrder('AWAITING_PAYMENT', 'PAID')).toBe(true);
    expect(canTransitionOrder('PAID', 'DRAFT')).toBe(false);
    expect(() => assertOrderTransition('REFUNDED', 'PAID')).toThrow(/cannot move/);
    expect(() => assertOrderTransition('CANCELLED', 'AWAITING_PAYMENT')).toThrow(/cannot move/);
  });

  it('reinstates a cancelled order only when its payment completes late', () => {
    expect(canTransitionOrder('CANCELLED', 'PAID')).toBe(true);
    expect(canTransitionPayment('CANCELLED', 'COMPLETED')).toBe(true);
    expect(canTransitionPayment('CANCELLED', 'APPROVED')).toBe(false);
  });

  it('ignores stale or duplicate payment events', () => {
    expect(canTransitionPayment('CREATED', 'COMPLETED')).toBe(true);
    expect(canTransitionPayment('COMPLETED', 'APPROVED')).toBe(false);
    expect(canTransitionPayment('COMPLETED', 'COMPLETED')).toBe(false);
    expect(canTransitionPayment('COMPLETED', 'REFUNDED')).toBe(true);
  });
});
