import type { OrderInputMode, OrderStatus, PaymentStatus } from '@vca/database';

// Dependency-free (type-only imports) so the dashboard's client components can use it.

/**
 * Status names for people. DRAFT is an order the merchant hasn't confirmed yet (the
 * "awaiting confirmation" step); CANCELLED drafts were discarded with CANCEL.
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

/** CREATED = link sent, buyer hasn't paid; APPROVED = buyer approved, capture pending. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  CREATED: 'Awaiting buyer',
  APPROVED: 'Approved',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export const INPUT_MODE_LABELS: Record<OrderInputMode, string> = {
  TEXT: 'Text',
  VOICE: 'Voice note',
};
