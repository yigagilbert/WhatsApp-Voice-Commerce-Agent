import type { AuditEvent } from './types';

/**
 * Turns audit events into plain language for the Activity page, tagged with the step of
 * Katale's responsible-commerce chain they belong to. Never shows secrets: only fields the
 * audit trail already stores, summarised.
 */
export type Stage =
  | 'Input'
  | 'AI interprets'
  | 'Backend verifies'
  | 'Merchant approves'
  | 'PayPal executes'
  | 'Notified'
  | 'Dispute'
  | 'Problem';

export interface DescribedEvent {
  stage: Stage;
  title: string;
  detail?: string;
}

type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const usd = (minor: unknown, currency: unknown) =>
  typeof minor === 'number'
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: str(currency) ?? 'USD',
      }).format(minor / 100)
    : undefined;
const seconds = (ms: unknown) =>
  typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : undefined;
const join = (...parts: (string | undefined | false)[]) =>
  parts.filter(Boolean).join(' · ') || undefined;

const TOOL_LABELS: Record<string, string> = {
  create_draft_order: 'draft an order',
  calculate_order_total: 'price a quote',
  request_payment: 'request payment',
  find_customer: 'look up a customer',
  get_customer_summary: 'customer summary',
  list_products: 'list products',
  find_product: 'find a product',
  check_inventory: 'check stock',
  find_orders: 'find orders',
  get_order: 'look up an order',
  get_payment_status: 'payment status',
  list_payments: 'list payments',
  get_sales_summary: 'sales summary',
  get_shipping_status: 'shipping status',
  list_shipments: 'list shipments',
  add_shipment_tracking: 'propose shipment tracking',
  list_disputes: 'list disputes',
  get_dispute: 'review a dispute',
  prepare_dispute_response: 'draft a dispute response',
  refresh_disputes: 'refresh disputes',
  create_customer: 'add a customer',
};

export function describeEvent(event: Pick<AuditEvent, 'type' | 'data'>): DescribedEvent {
  const d = (event.data ?? {}) as Data;
  switch (event.type) {
    case 'message.received': {
      const channel = d.channel === 'web' ? 'Agent console' : 'WhatsApp';
      const kind =
        d.kind === 'audio'
          ? 'voice note'
          : d.kind === 'text'
            ? 'message'
            : 'message (unsupported type)';
      return { stage: 'Input', title: `${channel} ${kind} received` };
    }
    case 'speech.transcribed':
      return {
        stage: 'Input',
        title: 'Voice note transcribed',
        detail: join(
          str(d.transcript) && `“${str(d.transcript)}”`,
          num(d.audioSeconds) !== undefined && `${num(d.audioSeconds)!.toFixed(1)} s audio`,
          num(d.confidence) !== undefined && `confidence ${num(d.confidence)!.toFixed(2)}`,
          seconds(d.sttMs) && `speech-to-text ${seconds(d.sttMs)}`,
        ),
      };
    case 'voice.processed':
      return {
        stage: 'Input',
        title:
          d.outcome === 'low_confidence_readback'
            ? 'Unclear voice note read back to the merchant'
            : d.outcome === 'spoken_confirmation_refused'
              ? 'Spoken approval refused (must be typed)'
              : 'Voice note answered',
        detail: join(seconds(d.voiceToReplyMs) && `voice → reply ${seconds(d.voiceToReplyMs)}`),
      };
    case 'agent.intent_interpreted': {
      const tools = Array.isArray(d.tools) ? (d.tools as { tool?: string; ok?: boolean }[]) : [];
      const used = [
        ...new Set(
          tools.map((t) => (t.tool ? (TOOL_LABELS[t.tool] ?? t.tool) : '')).filter(Boolean),
        ),
      ];
      return {
        stage: 'AI interprets',
        title: used.length ? `AI chose: ${used.join(', ')}` : 'AI answered without tools',
        detail: join(str(d.model)),
      };
    }
    case 'order.drafted': {
      const warnings = Array.isArray(d.warnings) ? d.warnings.length : 0;
      return {
        stage: 'Backend verifies',
        title: `Order ${str(d.reference) ?? ''} drafted — total calculated by the backend`,
        detail: join(
          usd(d.totalMinor, d.currency),
          warnings > 0 && `${warnings} warning${warnings === 1 ? '' : 's'} shown to the merchant`,
        ),
      };
    }
    case 'confirmation.proposed':
      return {
        stage: 'Backend verifies',
        title:
          d.action === 'ADD_SHIPMENT_TRACKING'
            ? 'Shipment update validated and sent for approval'
            : d.action === 'SUBMIT_DISPUTE_RESPONSE'
              ? 'Dispute response drafted from trusted evidence, sent for approval'
              : 'Confirmation code sent to the merchant',
      };
    case 'confirmation.received': {
      const word =
        d.action === 'ADD_SHIPMENT_TRACKING'
          ? 'SHIP'
          : d.action === 'SUBMIT_DISPUTE_RESPONSE'
            ? 'SUBMIT'
            : 'CONFIRM';
      return {
        stage: 'Merchant approves',
        title: `Merchant typed ${word} ${str(d.code) ?? ''}`.trim(),
      };
    }
    case 'shipment.tracking_added':
      return {
        stage: 'PayPal executes',
        title: 'Tracking added at PayPal',
        detail: join(str(d.orderReference), str(d.carrier), str(d.trackingNumber)),
      };
    case 'dispute.opened':
      return {
        stage: 'Dispute',
        title: 'PayPal dispute opened',
        detail: join(
          str(d.paypalDisputeId),
          str(d.orderReference) ?? 'not matched to an order',
          str(d.reason),
          str(d.amount),
        ),
      };
    case 'dispute.updated':
      return {
        stage: 'Dispute',
        title: `Dispute status: ${String(d.status ?? '')
          .toLowerCase()
          .replace(/_/g, ' ')}`,
        detail: str(d.paypalDisputeId),
      };
    case 'dispute.resolved':
      return { stage: 'Dispute', title: 'Dispute resolved', detail: str(d.paypalDisputeId) };
    case 'dispute.response_submitted':
      return {
        stage: 'PayPal executes',
        title: 'Dispute response submitted to PayPal',
        detail: join(
          str(d.paypalDisputeId),
          Array.isArray(d.evidence)
            ? `evidence: ${(d.evidence as string[]).join(', ')}`
            : undefined,
        ),
      };
    case 'confirmation.cancelled':
      return { stage: 'Merchant approves', title: 'Merchant cancelled the request' };
    case 'order.discarded':
      return {
        stage: 'Merchant approves',
        title: `Draft ${str(d.reference) ?? ''} discarded`.trim(),
      };
    case 'payment.requested':
      return {
        stage: 'PayPal executes',
        title: 'PayPal checkout created',
        detail: join(str(d.orderReference), usd(d.amountMinor, d.currency)),
      };
    case 'webhook.received':
      return {
        stage: 'PayPal executes',
        title: 'PayPal webhook received (signature verified)',
        detail: str(d.eventType),
      };
    case 'payment.completed':
      return {
        stage: 'PayPal executes',
        title: 'Payment completed — order marked paid',
        detail: str(d.orderReference),
      };
    case 'payment.approved':
      return {
        stage: 'PayPal executes',
        title: 'Buyer approved; PayPal is completing the capture',
      };
    case 'notification.sent':
      return { stage: 'Notified', title: 'WhatsApp message sent', detail: str(d.preview) };
    case 'payment.failed':
    case 'payment.request_failed':
    case 'confirmation.execution_failed':
    case 'notification.failed':
      return {
        stage: 'Problem',
        title:
          {
            'payment.failed': 'PayPal declined the payment',
            'payment.request_failed': 'PayPal checkout could not be created',
            'confirmation.execution_failed': 'Confirmed action failed — nothing was charged',
            'notification.failed': 'WhatsApp message could not be delivered',
          }[event.type] ?? event.type,
      };
    default:
      return { stage: 'Backend verifies', title: event.type.replace(/[._]/g, ' ') };
  }
}
