import { describe, expect, it } from 'vitest';
import { buildAttention, type AttentionFacts } from './attention';

const none: AttentionFacts = {
  disputesNeedingResponse: 0,
  nextDisputeDue: null,
  duplicatePayments: 0,
  paidAfterCancel: 0,
  toShip: 0,
  oldestToShipDays: null,
  toApprove: 0,
  awaitingPayment: 0,
  paymentDueSoon: 0,
  expiredThisWeek: 0,
  outOfStock: 0,
  lowStock: 0,
};
const now = new Date('2026-11-04T12:00:00Z');

describe('buildAttention', () => {
  it('stays quiet when nothing needs attention', () => {
    expect(buildAttention(none, now)).toEqual([]);
  });

  it('puts money and deadlines first, routine follow-ups last', () => {
    const items = buildAttention(
      {
        ...none,
        awaitingPayment: 3,
        toShip: 2,
        expiredThisWeek: 1,
        disputesNeedingResponse: 1,
        nextDisputeDue: '2026-11-06T12:00:00Z',
        lowStock: 4,
      },
      now,
    );
    expect(items.map((i) => i.id)).toEqual([
      'disputes',
      'to-ship',
      'low-stock',
      'awaiting-payment',
      'expired',
    ]);
    expect(items[0]?.detail).toBe('The next response is due in 2 days.');
  });

  it('links each item to a page narrowed to those records', () => {
    const items = buildAttention({ ...none, toShip: 1, outOfStock: 1, duplicatePayments: 1 }, now);
    expect(items.map((i) => i.href)).toEqual([
      '/orders?view=review',
      '/products?view=out-of-stock',
      '/orders?view=to-ship',
    ]);
  });

  it('says so when a dispute deadline has passed, and uses the singular', () => {
    const [dispute] = buildAttention(
      { ...none, disputesNeedingResponse: 1, nextDisputeDue: '2026-11-01T12:00:00Z' },
      now,
    );
    expect(dispute?.title).toBe('1 PayPal dispute needs your response');
    expect(dispute?.detail).toBe('The response deadline has passed.');
  });

  it('warns about unpaid orders only when one is about to be cancelled', () => {
    expect(buildAttention({ ...none, awaitingPayment: 2 }, now)[0]?.severity).toBe('info');
    const [soon] = buildAttention({ ...none, awaitingPayment: 2, paymentDueSoon: 1 }, now);
    expect(soon?.severity).toBe('warning');
    expect(soon?.detail).toBe('1 will be cancelled within 24 hours if unpaid.');
  });
});
