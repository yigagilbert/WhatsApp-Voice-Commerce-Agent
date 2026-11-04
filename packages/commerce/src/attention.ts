/**
 * What a merchant should look at next, most pressing first. A pure function over counts the
 * service reads from the database, so the wording and ranking are unit-tested and no number here
 * is estimated. Each item links to the page where the merchant can act on it.
 */
export interface AttentionFacts {
  disputesNeedingResponse: number;
  /** ISO time of the earliest seller response deadline. */
  nextDisputeDue: string | null;
  duplicatePayments: number;
  paidAfterCancel: number;
  toShip: number;
  oldestToShipDays: number | null;
  /** Customer orders waiting for the owner's approval. */
  toApprove: number;
  awaitingPayment: number;
  /** Awaiting payment and cancelled automatically within 24 hours if unpaid. */
  paymentDueSoon: number;
  /** Cancelled in the last 7 days because the payment link was not paid in time. */
  expiredThisWeek: number;
  outOfStock: number;
  lowStock: number;
}

export type AttentionSeverity = 'urgent' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  count: number;
  href: string;
  action: string;
}

const DAY_MS = 86_400_000;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const dueIn = (due: string | null, now: Date): string => {
  if (!due) return 'Reply before PayPal decides without you.';
  const days = Math.ceil((new Date(due).getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return 'The response deadline has passed.';
  if (days === 0) return 'The next response is due today.';
  return `The next response is due in ${days} ${plural(days, 'day', 'days')}.`;
};

export function buildAttention(facts: AttentionFacts, now = new Date()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (item: AttentionItem) => {
    if (item.count > 0) items.push(item);
  };

  add({
    id: 'disputes',
    severity: 'urgent',
    count: facts.disputesNeedingResponse,
    title: `${facts.disputesNeedingResponse} PayPal ${plural(facts.disputesNeedingResponse, 'dispute needs', 'disputes need')} your response`,
    detail: dueIn(facts.nextDisputeDue, now),
    href: '/disputes?view=needs-response',
    action: 'Respond',
  });
  add({
    id: 'duplicate-payments',
    severity: 'urgent',
    count: facts.duplicatePayments,
    title: `${facts.duplicatePayments} ${plural(facts.duplicatePayments, 'order was', 'orders were')} paid twice`,
    detail: 'The extra payment is not counted as revenue. Refund it to the customer.',
    href: '/orders?view=review',
    action: 'Review',
  });
  add({
    id: 'paid-after-cancel',
    severity: 'urgent',
    count: facts.paidAfterCancel,
    title: `${facts.paidAfterCancel} ${plural(facts.paidAfterCancel, 'order was', 'orders were')} paid after cancellation`,
    detail: 'Check the stock is still available. Shipping stays blocked until you review.',
    href: '/orders?view=review',
    action: 'Review',
  });
  add({
    id: 'out-of-stock',
    severity: 'urgent',
    count: facts.outOfStock,
    title: `${facts.outOfStock} ${plural(facts.outOfStock, 'product is', 'products are')} out of stock`,
    detail: 'Customers cannot order these until you restock.',
    href: '/products?view=out-of-stock',
    action: 'Restock',
  });
  add({
    id: 'to-ship',
    severity: 'warning',
    count: facts.toShip,
    title: `${facts.toShip} paid ${plural(facts.toShip, 'order', 'orders')} to ship`,
    detail:
      facts.oldestToShipDays && facts.oldestToShipDays > 0
        ? `The oldest has been waiting ${facts.oldestToShipDays} ${plural(facts.oldestToShipDays, 'day', 'days')}.`
        : 'Add tracking so PayPal and the customer can see it is on its way.',
    href: '/orders?view=to-ship',
    action: 'Ship',
  });
  add({
    id: 'to-approve',
    severity: 'warning',
    count: facts.toApprove,
    title: `${facts.toApprove} customer ${plural(facts.toApprove, 'order', 'orders')} to approve`,
    detail: 'A payment link goes out once you approve.',
    href: '/orders?view=to-approve',
    action: 'Approve',
  });
  add({
    id: 'low-stock',
    severity: 'warning',
    count: facts.lowStock,
    title: `${facts.lowStock} ${plural(facts.lowStock, 'product is', 'products are')} running low`,
    detail: 'Stock is at or below the reorder level you set.',
    href: '/products?view=low-stock',
    action: 'Restock',
  });
  add({
    id: 'awaiting-payment',
    severity: facts.paymentDueSoon > 0 ? 'warning' : 'info',
    count: facts.awaitingPayment,
    title: `${facts.awaitingPayment} ${plural(facts.awaitingPayment, 'order', 'orders')} awaiting PayPal payment`,
    detail:
      facts.paymentDueSoon > 0
        ? `${facts.paymentDueSoon} will be cancelled within 24 hours if unpaid.`
        : 'Send a reminder if a customer has gone quiet.',
    href: '/orders?view=awaiting-payment',
    action: 'Follow up',
  });
  add({
    id: 'expired',
    severity: 'info',
    count: facts.expiredThisWeek,
    title: `${facts.expiredThisWeek} payment ${plural(facts.expiredThisWeek, 'link', 'links')} expired this week`,
    detail: 'The orders were cancelled and their stock released.',
    href: '/orders?view=expired',
    action: 'View',
  });

  return items;
}
