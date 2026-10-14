import { ConflictError } from '@vca/shared';
import type { OrderStatus, PaymentStatus } from '@vca/database';

/** Allowed order status transitions. Anything else is a bug or a replayed event. */
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

/** Allowed payment status transitions. Webhooks may arrive late or out of order. */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ['APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  APPROVED: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_TRANSITIONS[from].includes(to);

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new ConflictError(`Order cannot move from ${from} to ${to}`);
  }
}

/**
 * Returns false (rather than throwing) for disallowed payment transitions: a stale or
 * duplicate provider event is expected and must be ignored, not treated as a failure.
 */
export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus): boolean =>
  from !== to && PAYMENT_TRANSITIONS[from].includes(to);

export { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, INPUT_MODE_LABELS } from './labels';
