import { formatMoney } from './money';

/**
 * Deterministic, backend-generated text shown to the merchant before confirmation.
 * The LLM never writes these numbers — this function does, from database values.
 * Uses WhatsApp-style *bold*, which also reads fine on other channels.
 */
export interface OrderSummaryInput {
  reference: string;
  customerName: string;
  isNewCustomer?: boolean;
  currency: string;
  items: {
    description: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[];
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  warnings?: string[];
}

export function formatOrderSummary(order: OrderSummaryInput): string {
  const m = (minor: number) => formatMoney(minor, order.currency);
  const lines = [
    `*Draft order ${order.reference}*`,
    `Customer: ${order.customerName}${order.isNewCustomer ? ' (new customer)' : ''}`,
    '',
    ...order.items.map(
      (i) =>
        `${i.quantity} × ${i.description}${i.quantity > 1 ? ` @ ${m(i.unitPriceMinor)}` : ''} — ${m(i.lineTotalMinor)}`,
    ),
  ];
  const extras = order.shippingMinor > 0 || order.taxMinor > 0;
  if (extras && order.items.length > 1) lines.push(`Subtotal — ${m(order.subtotalMinor)}`);
  if (order.shippingMinor > 0) lines.push(`Shipping — ${m(order.shippingMinor)}`);
  if (order.taxMinor > 0) lines.push(`Tax — ${m(order.taxMinor)}`);
  lines.push('', `*Total — ${m(order.totalMinor)}*`);
  if (order.warnings?.length) lines.push('', ...order.warnings.map((w) => `⚠️ ${w}`));
  return lines.join('\n');
}

/** e.g. "Reply *CONFIRM 4821* to create the PayPal payment request, or *CANCEL* to discard it." */
export function formatConfirmationPrompt(params: {
  /** Completes "Reply CONFIRM 1234 to …", e.g. "create the PayPal payment request". */
  actionDescription: string;
  code: string;
  ttlSeconds: number;
  /** Approval word: CONFIRM (default), SHIP or SUBMIT. */
  word?: string;
}): string {
  const minutes = Math.max(1, Math.round(params.ttlSeconds / 60));
  return [
    `Reply *${params.word ?? 'CONFIRM'} ${params.code}* to ${params.actionDescription}, or *CANCEL* to discard it.`,
    `_Expires in ${minutes} minute${minutes === 1 ? '' : 's'}._`,
  ].join('\n');
}
