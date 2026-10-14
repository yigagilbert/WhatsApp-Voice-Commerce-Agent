import {
  evaluatePaymentRequest,
  formatMoney,
  type AuditService,
  type ConfirmationService,
  type OrderService,
  type PaymentPolicyConfig,
} from '@vca/commerce';
import type { ActionConfirmation, ConfirmationAction, Merchant } from '@vca/database';
import {
  AppError,
  ConflictError,
  PolicyViolationError,
  getCorrelationId,
  newCorrelationId,
  runWithContext,
  type Logger,
} from '@vca/shared';
import { z } from 'zod';
import type { NotificationService } from '../notifications/notification.service';
import { branded, copy } from './copy';
import type { PaymentService } from '../payments/payment.service';
import { ShipmentService, shipmentPayloadSchema } from '../shipments/shipment.service';
import { disputeResponsePayloadSchema, type DisputeService } from '../disputes/dispute.service';

const paymentRequestPayloadSchema = z.object({
  orderId: z.string(),
  orderReference: z.string(),
  totalMinor: z.number().int().positive(),
  currency: z.string().length(3),
});

const orderReferenceOf = (confirmation: ActionConfirmation): string | null => {
  const ref = (confirmation.payload as { orderReference?: unknown } | null)?.orderReference;
  return typeof ref === 'string' ? ref : null;
};

const disputeIdOf = (confirmation: ActionConfirmation): string | null => {
  const payload = disputeResponsePayloadSchema.safeParse(confirmation.payload);
  return payload.success ? payload.data.paypalDisputeId : null;
};

type Handler = (confirmation: ActionConfirmation, merchant: Merchant) => Promise<string>;

/**
 * Executes confirmed actions. This is the only path from conversation to money movement:
 * claimed confirmation → payload re-validated against the database → policy re-checked →
 * trusted PaymentService → PayPal.
 */
export class ConfirmationExecutor {
  private readonly handlers: Partial<Record<ConfirmationAction, Handler>>;

  constructor(
    private readonly deps: {
      orders: OrderService;
      payments: PaymentService;
      shipments: ShipmentService;
      disputes: DisputeService;
      confirmations: ConfirmationService;
      notifications: NotificationService;
      audit: AuditService;
      policy: PaymentPolicyConfig;
      logger: Logger;
    },
  ) {
    this.handlers = {
      CREATE_PAYMENT_REQUEST: (c, m) => this.createPaymentRequest(c, m),
      ADD_SHIPMENT_TRACKING: (c, m) => this.addShipmentTracking(c, m),
      SUBMIT_DISPUTE_RESPONSE: (c, m) => this.submitDisputeResponse(c, m),
      // SEND_INVOICE and REFUND_PAYMENT: add handlers here when their tools are introduced.
    };
  }

  /** Runs a CONFIRMED action and returns the reply for the merchant. Never throws for expected failures. */
  async execute(confirmation: ActionConfirmation, merchant: Merchant): Promise<string> {
    // Continue the transaction trace started by the request that proposed this action, so the
    // draft, confirmation, PayPal request and later capture share one correlation ID.
    const traceId = confirmation.correlationId ?? getCorrelationId() ?? newCorrelationId();
    if (traceId !== getCorrelationId())
      this.deps.logger.info({ traceId }, 'continuing transaction trace');
    return runWithContext({ correlationId: traceId, merchantId: merchant.id }, () =>
      this.run(confirmation, merchant),
    );
  }

  private async run(confirmation: ActionConfirmation, merchant: Merchant): Promise<string> {
    const handler = this.handlers[confirmation.action];
    try {
      if (!handler) throw new ConflictError(`Action ${confirmation.action} is not supported yet`);
      return await handler(confirmation, merchant);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.confirmations.markFailed(confirmation.id, message);
      await this.deps.audit.record({
        merchantId: merchant.id,
        actor: 'SYSTEM',
        type: 'confirmation.execution_failed',
        entityType: 'confirmation',
        entityId: confirmation.id,
        data: { action: confirmation.action, error: message },
      });
      this.deps.logger.warn(
        { err: error, confirmationId: confirmation.id },
        'confirmed action failed',
      );
      // Business-rule failures (policy, changed order, not configured) are explained; provider
      // outages get a reassuring, non-technical message; anything else stays generic.
      if (
        error instanceof AppError &&
        error.code.startsWith('PROVIDER') &&
        error.code !== 'PROVIDER_NOT_CONFIGURED'
      ) {
        const reference = orderReferenceOf(confirmation);
        if (confirmation.action === 'CREATE_PAYMENT_REQUEST' && reference)
          return copy.paymentRequestFailed(reference);
        if (confirmation.action === 'ADD_SHIPMENT_TRACKING' && reference)
          return copy.shipmentFailed(reference);
        if (confirmation.action === 'SUBMIT_DISPUTE_RESPONSE')
          return copy.disputeSubmitFailed(
            disputeIdOf(confirmation) ?? '',
            'PayPal could not accept it right now. Please try again later.',
          );
      }
      const explain =
        error instanceof AppError &&
        (error.httpStatus < 500 || error.code === 'PROVIDER_NOT_CONFIGURED');
      return explain ? copy.actionFailed(message) : copy.unexpectedError;
    }
  }

  /**
   * The merchant cancelled a pending payment request: the draft it was for is discarded
   * (DRAFT → CANCELLED) so it doesn't linger as open work. Returns the order reference.
   */
  async discard(confirmation: ActionConfirmation, merchant: Merchant): Promise<string | null> {
    if (confirmation.action !== 'CREATE_PAYMENT_REQUEST') return null;
    const payload = paymentRequestPayloadSchema.safeParse(confirmation.payload);
    if (!payload.success) return null;
    const moved = await this.deps.orders.transition(payload.data.orderId, 'DRAFT', 'CANCELLED');
    if (moved) {
      await this.deps.audit.record({
        merchantId: merchant.id,
        actor: 'MERCHANT',
        type: 'order.discarded',
        entityType: 'order',
        entityId: payload.data.orderId,
        correlationId: confirmation.correlationId,
        data: { reference: payload.data.orderReference },
      });
    }
    return payload.data.orderReference;
  }

  /**
   * A confirmation code that was already used (a duplicated "CONFIRM 4821"): describe the
   * current, trusted state of what it created. Never executes anything.
   */
  async describeSettled(confirmation: ActionConfirmation, merchant: Merchant): Promise<string> {
    if (confirmation.status !== 'EXECUTED') return copy.stillProcessing;
    if (confirmation.action === 'ADD_SHIPMENT_TRACKING') {
      const p = shipmentPayloadSchema.parse(confirmation.payload);
      return `That tracking was already added: ${p.orderReference}, ${p.carrierLabel} ${p.trackingNumber}. Nothing new was sent to PayPal.`;
    }
    if (confirmation.action === 'SUBMIT_DISPUTE_RESPONSE') {
      const p = disputeResponsePayloadSchema.parse(confirmation.payload);
      return `That response was already submitted for dispute ${p.paypalDisputeId}. Nothing new was sent to PayPal.`;
    }
    const payload = paymentRequestPayloadSchema.safeParse(confirmation.payload);
    if (confirmation.action !== 'CREATE_PAYMENT_REQUEST' || !payload.success)
      return copy.alreadyConfirmed([]);
    const order = await this.deps.orders.getByReference(merchant.id, payload.data.orderId);
    const payment = order.payments[0];
    return copy.alreadyConfirmed([
      `Order: ${order.reference}`,
      `Amount: ${formatMoney(order.totalMinor, order.currency)}`,
      `Status: ${order.status === 'PAID' ? 'Paid ✅' : order.status === 'AWAITING_PAYMENT' ? 'Awaiting payment' : order.status.toLowerCase()}`,
      ...(order.status === 'AWAITING_PAYMENT' && payment?.checkoutUrl
        ? ['', 'Payment link:', payment.checkoutUrl]
        : []),
    ]);
  }

  private async addShipmentTracking(confirmation: ActionConfirmation, merchant: Merchant) {
    const payload = shipmentPayloadSchema.parse(confirmation.payload);
    const { order } = await this.deps.shipments.addTracking(payload, merchant);
    await this.deps.confirmations.markExecuted(confirmation.id, {
      orderReference: payload.orderReference,
      trackingNumber: payload.trackingNumber,
    });
    return copy.shipmentUpdated(
      ShipmentService.describe(payload, order).filter((l) => !l.startsWith('Amount')),
    );
  }

  private async submitDisputeResponse(confirmation: ActionConfirmation, merchant: Merchant) {
    const payload = disputeResponsePayloadSchema.parse(confirmation.payload);
    const { response } = await this.deps.disputes.submit(payload, confirmation.id, merchant);
    await this.deps.confirmations.markExecuted(confirmation.id, { disputeResponseId: response.id });
    const dispute = await this.deps.disputes.find(merchant.id, payload.paypalDisputeId);
    return copy.disputeSubmitted(
      [
        `Dispute: ${payload.paypalDisputeId}`,
        ...(dispute.order ? [`Order: ${dispute.order.reference}`] : []),
      ],
      payload.evidence.map((e) => e.label),
    );
  }

  private async createPaymentRequest(
    confirmation: ActionConfirmation,
    merchant: Merchant,
  ): Promise<string> {
    const payload = paymentRequestPayloadSchema.parse(confirmation.payload);
    const order = await this.deps.orders.getByReference(merchant.id, payload.orderId);

    // The order must be exactly what the merchant saw when confirming.
    if (order.totalMinor !== payload.totalMinor || order.currency !== payload.currency) {
      throw new ConflictError(
        `Order ${order.reference} changed after the summary was shown. Please review it again.`,
      );
    }
    const decision = evaluatePaymentRequest(order, this.deps.policy);
    if (!decision.allowed) throw new PolicyViolationError(decision.reason);

    const payment = await this.deps.payments.createCheckout(order, confirmation.id);
    await this.deps.confirmations.markExecuted(confirmation.id, {
      paymentId: payment.id,
      paypalOrderId: payment.externalId,
    });

    const total = formatMoney(order.totalMinor, order.currency);
    const sentToCustomer = await this.deps.notifications.toCustomer(
      order.customer,
      `Hello ${order.customer.name}, ${merchant.businessName} has sent you a payment request for order ${order.reference}: *${total}*.\n\nPay securely with PayPal:\n${payment.checkoutUrl}`,
    );

    return branded(
      [
        '✅ *Payment request created*',
        '',
        `Order: ${order.reference}`,
        `Customer: ${order.customer.name}`,
        `Amount: ${total}`,
        '',
        'Pay securely with PayPal:',
        // On its own line so WhatsApp renders it as a tappable link.
        `${payment.checkoutUrl}`,
        '',
        sentToCustomer
          ? `I've also sent the link to ${order.customer.name} on WhatsApp.`
          : `Share this link with ${order.customer.name}. I'll let you know as soon as the payment arrives.`,
      ].join('\n'),
    );
  }
}
