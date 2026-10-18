import {
  ACTIVE_DISPUTE_STATUSES,
  formatMoney,
  normalizeCurrency,
  toMinorUnits,
  type AuditService,
} from '@vca/commerce';
import type { Database, Dispute, Merchant, Prisma } from '@vca/database';
import {
  disputeCarrierName,
  type DisputeEvidence,
  type PayPalApi,
  type PayPalDispute,
} from '@vca/paypal';
import {
  ConflictError,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  type Logger,
} from '@vca/shared';
import { z } from 'zod';
import type { NotificationService } from '../notifications/notification.service';
import { carrierDisplay } from '../shipments/shipment.service';

/** PayPal dispute reasons in plain language. */
export const DISPUTE_REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
  UNAUTHORISED: 'Unauthorised payment',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate transaction',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Cancelled recurring billing',
  PROBLEM_WITH_REMITTANCE: 'Problem with remittance',
  OTHER: 'Other',
};

/** PayPal dispute statuses (Disputes v1 `status`) in plain language. */
export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  WAITING_FOR_SELLER_RESPONSE: 'Needs your response',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting for buyer',
  UNDER_REVIEW: 'Under PayPal review',
  RESOLVED: 'Resolved',
  OTHER: 'Other',
};

/** Only these status changes are worth a WhatsApp message. */
const NOTIFY_ON = new Set(['NEW', 'WAITING_FOR_SELLER_RESPONSE', 'RESOLVED']);

export const reasonLabel = (reason: string) =>
  DISPUTE_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
export const statusLabel = (status: string) => DISPUTE_STATUS_LABELS[status] ?? status;

/** What a SUBMIT confirmation is bound to: the exact text and evidence sent to PayPal. */
export const disputeResponsePayloadSchema = z.object({
  disputeId: z.string(),
  paypalDisputeId: z.string(),
  responseText: z.string(),
  evidence: z.array(z.object({ type: z.string(), label: z.string(), detail: z.string() })),
  paypalEvidences: z.array(z.record(z.string(), z.unknown())),
});
export type DisputeResponsePayload = z.infer<typeof disputeResponsePayloadSchema>;

export interface EvidenceFact {
  label: string;
  value: string;
}

const disputeInclude = {
  order: {
    include: {
      customer: true,
      items: { orderBy: { position: 'asc' as const } },
      shipments: { where: { status: 'SHIPPED' as const }, orderBy: { shippedAt: 'asc' as const } },
    },
  },
  payment: true,
  responses: { orderBy: { createdAt: 'desc' as const } },
};
type DisputeWithContext = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;

const day = (d: Date | null | undefined, timeZone = 'UTC') =>
  d ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone }).format(d) : '';

/** Wording a merchant-approved response must not contain in this phase (no refunds/offers/concessions). */
const CONCESSION =
  /\b(refund|reimburs|settle|settlement|offer|compensat|accept(?:ing)? (?:the )?(?:claim|liability|responsibility)|partial(?:ly)? (?:refund|credit))/i;

/**
 * PayPal disputes, synchronised from PayPal and handled with the merchant: Katale gathers trusted
 * evidence and prepares a response; only a merchant's SUBMIT confirmation sends it to PayPal.
 * Katale never offers refunds, makes settlement offers or accepts claims.
 */
export class DisputeService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
  ) {}

  /**
   * Fetches the canonical dispute from PayPal (webhook payloads are only a trigger) and stores
   * it, linked to the Katale payment/order whose capture ID PayPal reports as disputed.
   * Notifies the merchant once per meaningful status.
   */
  async sync(paypalDisputeId: string, options: { notify?: boolean } = {}) {
    const d = await this.paypal.getDispute(paypalDisputeId);
    const tx = d.disputed_transactions?.[0];
    const captureId = tx?.seller_transaction_id;
    const payment = captureId
      ? await this.db.payment.findFirst({ where: { captureId }, include: { order: true } })
      : null;
    const merchantId = payment?.merchantId ?? (await this.soleMerchantId());
    const currency = d.dispute_amount?.currency_code
      ? normalizeCurrency(d.dispute_amount.currency_code)
      : null;
    const amountMinor =
      currency && d.dispute_amount?.value ? toMinorUnits(d.dispute_amount.value, currency) : null;
    const buyerMessage =
      d.messages?.find((m) => m.posted_by === 'BUYER')?.content ??
      tx?.items?.find((i) => i.notes)?.notes ??
      null;
    const status = d.status ?? 'OTHER';
    const data = {
      merchantId,
      orderId: payment?.orderId ?? null,
      paymentId: payment?.id ?? null,
      reason: d.reason ?? 'OTHER',
      status,
      lifecycleStage: d.dispute_life_cycle_stage ?? null,
      outcome: d.dispute_outcome?.outcome_code ?? null,
      amountMinor,
      currency,
      sellerTransactionId: captureId ?? null,
      buyerMessage: buyerMessage?.slice(0, 2000) ?? null,
      sellerResponseDueAt: d.seller_response_due_date ? new Date(d.seller_response_due_date) : null,
      openedAt: d.create_time ? new Date(d.create_time) : null,
      providerUpdatedAt: d.update_time ? new Date(d.update_time) : null,
      providerData: d as unknown as Prisma.InputJsonValue,
    };

    const before = await this.db.dispute.findUnique({ where: { paypalDisputeId } });
    const dispute = await this.db.dispute.upsert({
      where: { paypalDisputeId },
      update: data,
      create: { paypalDisputeId, ...data },
    });
    if (!before || before.status !== status) {
      await this.audit.record({
        merchantId,
        actor: 'PROVIDER',
        type: !before
          ? 'dispute.opened'
          : status === 'RESOLVED'
            ? 'dispute.resolved'
            : 'dispute.updated',
        entityType: 'dispute',
        entityId: dispute.id,
        correlationId: payment?.correlationId ?? null,
        data: {
          paypalDisputeId,
          orderReference: payment?.order.reference ?? null,
          reason: dispute.reason,
          status,
          ...(before ? { previousStatus: before.status } : {}),
          amount: amountMinor !== null && currency ? formatMoney(amountMinor, currency) : null,
        },
      });
    }
    if (options.notify !== false) await this.notifyIfMeaningful(dispute, !before);
    return dispute;
  }

  /** Audits a verified dispute webhook under the dispute's transaction trace. */
  async recordWebhook(dispute: Dispute, event: { id: string; event_type: string }, at?: Date) {
    const payment = dispute.paymentId
      ? await this.db.payment.findUnique({ where: { id: dispute.paymentId } })
      : null;
    await this.audit.record({
      merchantId: dispute.merchantId,
      actor: 'PROVIDER',
      type: 'webhook.received',
      entityType: 'dispute',
      entityId: dispute.id,
      correlationId: payment?.correlationId ?? null,
      data: { eventType: event.event_type, eventId: event.id, signature: 'verified' },
      ...(at ? { at } : {}),
    });
  }

  /** Pulls every dispute PayPal reports for this account (reconciliation / missed webhooks). */
  async refresh() {
    const summaries = await this.paypal.listDisputes({ pageSize: 50 });
    for (const s of summaries) await this.sync(s.dispute_id);
    return summaries.length;
  }

  /** Single-tenant shortcut: one PayPal account per deployment, so an unlinked dispute belongs to its only merchant. */
  private async soleMerchantId(): Promise<string | null> {
    const merchants = await this.db.merchant.findMany({ select: { id: true }, take: 2 });
    return merchants.length === 1 ? merchants[0]!.id : null;
  }

  private async notifyIfMeaningful(dispute: Dispute, isNew: boolean) {
    const key = isNew ? 'NEW' : dispute.status;
    if (!NOTIFY_ON.has(key) || dispute.notifiedStatus === key || !dispute.merchantId) return;
    // Claim the notification first so concurrent webhooks can't send it twice.
    const { count } = await this.db.dispute.updateMany({
      where: { id: dispute.id, OR: [{ notifiedStatus: null }, { notifiedStatus: { not: key } }] },
      data: { notifiedStatus: key },
    });
    if (count !== 1) return;
    const full = await this.db.dispute.findUniqueOrThrow({
      where: { id: dispute.id },
      include: disputeInclude,
    });
    const text = this.notificationText(full, key);
    // Every admin who opted in to alerts; otherwise the chat the order came from (or the most
    // recent admin chat).
    if (dispute.merchantId && (await this.notifications.toAdmins(dispute.merchantId, text))) return;
    const conversationId =
      full.order?.conversationId ?? (await this.merchantConversationId(dispute.merchantId));
    if (!conversationId) return;
    await this.notifications.toConversation(conversationId, text);
  }

  private async merchantConversationId(merchantId: string | null) {
    if (!merchantId) return null;
    const operators = await this.db.merchantOperator.findMany({
      where: { merchantId, channel: 'whatsapp' },
      select: { externalId: true },
    });
    const conversation = await this.db.conversation.findFirst({
      where: {
        merchantId,
        channel: 'whatsapp',
        externalChatId: { in: operators.map((o) => o.externalId) },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    return conversation?.id ?? null;
  }

  private notificationText(d: DisputeWithContext, key: string) {
    const amount =
      d.amountMinor !== null && d.currency ? formatMoney(d.amountMinor, d.currency) : null;
    const lines = [
      `Dispute: ${d.paypalDisputeId}`,
      d.order ? `Order: ${d.order.reference}` : 'Order: not matched to a Katale order',
      ...(d.order ? [`Customer: ${d.order.customer.name}`] : []),
      ...(amount ? [`Amount: ${amount}`] : []),
      `Reason: ${reasonLabel(d.reason)}`,
      ...(d.sellerResponseDueAt ? [`Response due: ${day(d.sellerResponseDueAt)}`] : []),
    ];
    const header =
      key === 'NEW'
        ? '⚠️ *New PayPal dispute*'
        : key === 'RESOLVED'
          ? `✅ *PayPal dispute resolved*${d.outcome ? ` (${d.outcome.toLowerCase().replace(/_/g, ' ')})` : ''}`
          : '⚠️ *PayPal dispute needs your response*';
    const footer =
      key === 'RESOLVED'
        ? ''
        : '\n\nAsk me to "review the dispute" and I\'ll gather the order, payment and shipment evidence. Nothing is sent to PayPal without your approval.';
    return `*Katale AI*\n\n${header}\n\n${lines.join('\n')}${footer}`;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async list(merchantId: string, filter: 'open' | 'needs_response' | 'resolved' | 'all' = 'open') {
    const where: Prisma.DisputeWhereInput = {
      merchantId,
      ...(filter === 'open' ? { status: { in: ACTIVE_DISPUTE_STATUSES } } : {}),
      ...(filter === 'needs_response' ? { status: 'WAITING_FOR_SELLER_RESPONSE' } : {}),
      ...(filter === 'resolved' ? { status: 'RESOLVED' } : {}),
    };
    const [disputes, totals] = await Promise.all([
      this.db.dispute.findMany({
        where,
        include: {
          order: {
            select: { reference: true, inputMode: true, customer: { select: { name: true } } },
          },
        },
        orderBy: [{ sellerResponseDueAt: 'asc' }, { openedAt: 'desc' }],
        take: 100,
      }),
      this.db.dispute.groupBy({
        by: ['currency'],
        where,
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
    ]);
    return {
      disputes,
      totals: totals
        .filter((t) => t.currency)
        .map((t) => ({
          currency: t.currency!,
          count: t._count._all,
          amount: formatMoney(t._sum.amountMinor ?? 0, t.currency!),
        })),
    };
  }

  /** One dispute by PayPal ID, order reference or customer name (most recent match). */
  async find(merchantId: string, ref: string): Promise<DisputeWithContext> {
    const q = ref.trim();
    const dispute = await this.db.dispute.findFirst({
      where: {
        merchantId,
        OR: [
          { paypalDisputeId: q },
          { order: { reference: q.toUpperCase() } },
          { order: { customer: { name: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      include: disputeInclude,
      orderBy: { openedAt: 'desc' },
    });
    if (!dispute) throw new NotFoundError('Dispute', q);
    return dispute;
  }

  /**
   * Trusted evidence for a dispute, from Katale's own records only: what exists (facts), what is
   * missing for this dispute reason, and which evidence PayPal would receive. Never invented.
   */
  evidenceFor(d: DisputeWithContext, timeZone = 'UTC') {
    const facts: EvidenceFact[] = [];
    const missing: string[] = [];
    const evidence: DisputeResponsePayload['evidence'] = [];
    const order = d.order;
    const payment = d.payment;
    const shipment = order?.shipments[0];

    if (!order) {
      missing.push(
        'This dispute is not linked to a Katale order (no payment with the disputed capture ID).',
      );
    } else {
      const m = (minor: number) => formatMoney(minor, order.currency);
      facts.push(
        {
          label: 'Order',
          value: `${order.reference} for ${order.customer.name}, created ${day(order.createdAt, timeZone)}`,
        },
        {
          label: 'Items',
          value: order.items
            .map((i) => `${i.quantity} × ${i.description} (${m(i.lineTotalMinor)})`)
            .join('; '),
        },
        { label: 'Order total', value: m(order.totalMinor) },
      );
      evidence.push({
        type: 'ORDER_DETAILS',
        label: 'Order details',
        detail: `${order.reference}: ${order.items.map((i) => `${i.quantity} × ${i.description}`).join(', ')}, total ${m(order.totalMinor)}`,
      });
    }
    if (payment?.status === 'COMPLETED') {
      facts.push({
        label: 'Payment',
        value: `${formatMoney(payment.amountMinor, payment.currency)} captured by PayPal on ${day(payment.completedAt, timeZone)} (capture ${payment.captureId ?? 'n/a'})`,
      });
      evidence.push({
        type: 'PAYMENT',
        label: 'Payment confirmation',
        detail: `Capture ${payment.captureId}`,
      });
    } else if (order) {
      missing.push('No completed PayPal payment found for this order in Katale.');
    }
    if (shipment) {
      facts.push({
        label: 'Shipment',
        value: `Shipped ${day(shipment.shippedAt, timeZone)} with ${carrierDisplay(shipment)}, tracking ${shipment.trackingNumber}${shipment.providerTrackerId ? ' (tracking registered with PayPal)' : ''}`,
      });
      evidence.push({
        type: 'PROOF_OF_FULFILLMENT',
        label: 'Shipment tracking',
        detail: `${carrierDisplay(shipment)} ${shipment.trackingNumber}, shipped ${day(shipment.shippedAt, timeZone)}`,
      });
    } else if (order) {
      missing.push(
        d.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
          ? 'No shipment tracking is attached to this order. For "item not received", valid tracking is the strongest evidence — add it first if the order was shipped.'
          : 'No shipment tracking is attached to this order.',
      );
    }
    if (d.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && shipment) {
      missing.push(
        "Proof of delivery: Katale has the tracking number but no delivery confirmation (PayPal tracking has no delivered status). The carrier's delivery record would strengthen the response.",
      );
    }
    if (d.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
      missing.push(
        'Photos or the original item description would help; Katale only has the order line items.',
      );
    }
    if (d.reason === 'UNAUTHORISED') {
      missing.push(
        'Katale has no information about who authorised the payment; PayPal reviews unauthorised claims itself.',
      );
    }
    return { facts, missing, evidence };
  }

  /**
   * A factual first draft written by code from the records (the seller's statement to PayPal).
   * The agent may shorten or rephrase it, but every fact in it is already verified.
   */
  suggestResponse(d: DisputeWithContext, timeZone = 'UTC'): string | null {
    const order = d.order;
    if (!order) return null;
    const m = (minor: number) => formatMoney(minor, order.currency);
    const items = order.items.map((i) => `${i.quantity} × ${i.description}`).join(', ');
    const parts = [`Order ${order.reference} (${items}, total ${m(order.totalMinor)})`];
    if (d.payment?.status === 'COMPLETED')
      parts[0] += ` was paid through PayPal on ${day(d.payment.completedAt, timeZone)}.`;
    else parts[0] += '.';
    const shipment = order.shipments[0];
    if (shipment) {
      parts.push(
        `It was shipped on ${day(shipment.shippedAt, timeZone)} with ${carrierDisplay(shipment)}, tracking number ${shipment.trackingNumber}${shipment.providerTrackerId ? ', which is registered with PayPal' : ''}.`,
      );
      parts.push('We ask PayPal to review the tracking information for this shipment.');
    } else {
      parts.push('We ask PayPal to review the order and payment details.');
    }
    return parts.join(' ');
  }

  /** Builds the PayPal provide-evidence payload from the trusted evidence and approved text. */
  private paypalEvidences(d: DisputeWithContext, responseText: string): DisputeEvidence[] {
    const shipment = d.order?.shipments[0];
    if (shipment) {
      const carrier = disputeCarrierName(shipment.carrier);
      return [
        {
          evidence_type: 'PROOF_OF_FULFILLMENT',
          evidence_info: {
            tracking_info: [
              {
                carrier_name: carrier,
                ...(carrier === 'OTHER' ? { carrier_name_other: carrierDisplay(shipment) } : {}),
                tracking_number: shipment.trackingNumber,
              },
            ],
          },
          notes: responseText,
        },
      ];
    }
    return [{ evidence_type: 'OTHER', notes: responseText }];
  }

  /**
   * Validates a drafted response against Katale's records and returns the payload a SUBMIT
   * confirmation is bound to. Sends nothing.
   */
  async prepareResponse(
    merchant: Pick<Merchant, 'id' | 'timezone'>,
    ref: string,
    responseText?: string,
  ) {
    const d = await this.find(merchant.id, ref);
    // Default: Katale's own factual draft from the records; custom wording is fact-checked below.
    const draft = responseText ?? this.suggestResponse(d, merchant.timezone);
    if (!draft)
      throw new ValidationError(
        'This dispute is not linked to a Katale order, so there are no records to draft from. Ask the merchant what to say.',
      );
    const text = draft.trim().replace(/\s+\n/g, '\n');
    if (d.status === 'RESOLVED')
      throw new ConflictError(`Dispute ${d.paypalDisputeId} is already resolved.`);
    if (text.length < 20 || text.length > 2000)
      throw new ValidationError('The response must be 20–2000 characters.');
    if (CONCESSION.test(text)) {
      throw new PolicyViolationError(
        'Katale can only send factual evidence. It cannot offer refunds, settlements or accept the claim — remove that wording.',
      );
    }
    const { facts, evidence } = this.evidenceFor(d, merchant.timezone);
    // Every reference-like token (tracking numbers, IDs, order references) must come from the records.
    const known =
      facts
        .map((f) => f.value)
        .join(' ')
        .toUpperCase() + ` ${d.paypalDisputeId}`.toUpperCase();
    const unknown = (text.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}\b/gi) ?? []).filter(
      (token) => !known.includes(token.toUpperCase()),
    );
    if (unknown.length) {
      throw new ValidationError(
        `The response mentions ${[...new Set(unknown)].join(', ')}, which isn't in Katale's records. Use only facts from the evidence.`,
      );
    }
    const payload: DisputeResponsePayload = {
      disputeId: d.id,
      paypalDisputeId: d.paypalDisputeId,
      responseText: text,
      evidence,
      paypalEvidences: this.paypalEvidences(d, text) as unknown as Record<string, unknown>[],
    };
    return { dispute: d, payload };
  }

  /**
   * Submits a merchant-approved response once: re-checks the dispute at PayPal, sends the
   * evidence, records the response. Repeating the same confirmation never resubmits.
   */
  async submit(
    payload: DisputeResponsePayload,
    confirmationId: string,
    merchant: Pick<Merchant, 'id'>,
  ) {
    const existing = await this.db.disputeResponse.findUnique({ where: { confirmationId } });
    if (existing?.status === 'SUBMITTED') return { response: existing, alreadySubmitted: true };

    const local = await this.db.dispute.findFirst({
      where: { id: payload.disputeId, merchantId: merchant.id },
    });
    if (!local) throw new NotFoundError('Dispute', payload.paypalDisputeId);
    // PayPal is the source of truth for whether a response is still allowed.
    const current: PayPalDispute = await this.paypal.getDispute(payload.paypalDisputeId);
    const canProvide =
      current.status === 'WAITING_FOR_SELLER_RESPONSE' ||
      (current.links ?? []).some((l) => l.rel === 'provide_evidence');
    if (!canProvide) {
      throw new ConflictError(
        `PayPal isn't accepting evidence for ${payload.paypalDisputeId} right now (status: ${statusLabel(current.status ?? 'OTHER')}).`,
      );
    }
    const response = await this.db.disputeResponse.upsert({
      where: { confirmationId },
      update: {},
      create: {
        disputeId: local.id,
        merchantId: merchant.id,
        confirmationId,
        responseText: payload.responseText,
        evidence: payload.evidence,
        status: 'PENDING',
      },
    });
    try {
      await this.paypal.provideDisputeEvidence(
        payload.paypalDisputeId,
        payload.paypalEvidences as unknown as DisputeEvidence[],
      );
    } catch (error) {
      await this.db.disputeResponse.update({
        where: { id: response.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 500) : 'failed',
        },
      });
      throw error;
    }
    const submitted = await this.db.disputeResponse.update({
      where: { id: response.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), error: null },
    });
    await this.audit.record({
      merchantId: merchant.id,
      actor: 'MERCHANT',
      type: 'dispute.response_submitted',
      entityType: 'dispute',
      entityId: local.id,
      data: {
        paypalDisputeId: payload.paypalDisputeId,
        evidence: payload.evidence.map((e) => e.label),
      },
    });
    await this.sync(payload.paypalDisputeId, { notify: false }).catch((error: unknown) =>
      this.logger.warn({ err: error }, 'dispute refresh after submission failed'),
    );
    return { response: submitted, alreadySubmitted: false };
  }
}
