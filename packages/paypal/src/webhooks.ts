import { z } from 'zod';
import type { WebhookSignatureHeaders } from './types';

/**
 * Orders v2 / Payments v2 webhook events to subscribe to (`pnpm paypal:webhook register`).
 * PAYMENT.CAPTURE.DENIED is a v1 name; v2 uses DECLINED (the handler accepts both).
 */
export const HANDLED_WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  // Disputes v1: new dispute, any change (evidence requests, messages, status), resolution.
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;
export type HandledWebhookEvent = (typeof HANDLED_WEBHOOK_EVENTS)[number];

export const webhookEnvelopeSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().optional(),
  create_time: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/** Reads PayPal's transmission headers; returns null if any are missing. */
export function readWebhookHeaders(
  headers: Record<string, string | string[] | undefined>,
): WebhookSignatureHeaders | null {
  const get = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const authAlgo = get('paypal-auth-algo');
  const certUrl = get('paypal-cert-url');
  const transmissionId = get('paypal-transmission-id');
  const transmissionSig = get('paypal-transmission-sig');
  const transmissionTime = get('paypal-transmission-time');
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime)
    return null;
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

const captureResourceSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
  custom_id: z.string().optional(),
  supplementary_data: z
    .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
    .optional(),
});

/** For PAYMENT.CAPTURE.* events: the capture ID, the PayPal order ID and our custom_id (payment ID). */
export function extractCaptureRefs(resource: Record<string, unknown>) {
  const parsed = captureResourceSchema.safeParse(resource);
  if (!parsed.success) return null;
  return {
    captureId: parsed.data.id,
    paypalOrderId: parsed.data.supplementary_data?.related_ids?.order_id,
    customId: parsed.data.custom_id,
    amount: parsed.data.amount
      ? { value: parsed.data.amount.value, currency: parsed.data.amount.currency_code }
      : undefined,
  };
}

const refundResourceSchema = z.object({
  id: z.string(),
  custom_id: z.string().optional(),
  supplementary_data: z
    .object({
      related_ids: z
        .object({ order_id: z.string().optional(), capture_id: z.string().optional() })
        .optional(),
    })
    .optional(),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
});

/**
 * For PAYMENT.CAPTURE.REFUNDED / REVERSED: where the resource is a refund, its own ID is the
 * refund ID, and the capture/order it belongs to come from `related_ids` or the `up` link. Only
 * used to find our payment; refund amounts are re-read from PayPal.
 */
export function extractRefundRefs(resource: Record<string, unknown>) {
  const parsed = refundResourceSchema.safeParse(resource);
  if (!parsed.success) return null;
  const related = parsed.data.supplementary_data?.related_ids;
  const up = parsed.data.links?.find((l) => l.rel === 'up')?.href;
  const captureFromLink = up?.match(/\/v2\/payments\/captures\/([^/?#]+)/)?.[1];
  return {
    resourceId: parsed.data.id,
    captureId: related?.capture_id ?? captureFromLink,
    paypalOrderId: related?.order_id,
    customId: parsed.data.custom_id,
  };
}

/** For CHECKOUT.ORDER.* events the resource is the order itself. */
export function extractOrderRefs(resource: Record<string, unknown>) {
  const id = typeof resource.id === 'string' ? resource.id : undefined;
  const units = Array.isArray(resource.purchase_units)
    ? (resource.purchase_units as { custom_id?: unknown }[])
    : [];
  const customId = typeof units[0]?.custom_id === 'string' ? units[0].custom_id : undefined;
  return id ? { paypalOrderId: id, customId } : null;
}

/** For CUSTOMER.DISPUTE.* events the resource is the dispute; we only trust its ID and re-fetch. */
export function extractDisputeId(resource: Record<string, unknown>): string | null {
  return typeof resource.dispute_id === 'string' &&
    /^[A-Za-z0-9-]{1,255}$/.test(resource.dispute_id)
    ? resource.dispute_id
    : null;
}
