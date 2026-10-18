import {
  canTransitionPayment,
  evaluatePaymentRequest,
  formatMoney,
  toMajorString,
  type AuditService,
  type InventoryService,
  type OrderService,
  type StockAlert,
  type PaymentPolicyConfig,
} from '@vca/commerce';
import type { Database, Payment, PaymentStatus } from '@vca/database';
import {
  ConflictError,
  PolicyViolationError,
  getContext,
  newCorrelationId,
  runWithContext,
  type Logger,
} from '@vca/shared';
import { payPalErrorIssues, type PayPalApi, type PayPalOrder } from '@vca/paypal';
import { branded } from '../agent/copy';
import type { NotificationService } from '../notifications/notification.service';

type OrderWithDetails = Awaited<ReturnType<OrderService['getByReference']>>;

/**
 * - completed: this call moved the payment to COMPLETED
 * - already_handled: it was already completed/closed (duplicate callback) — no side effects
 * - pending: PayPal accepted the capture but has not completed it (e.g. PENDING review)
 * - failed: PayPal declined the capture
 * - unknown_order: no payment matches the PayPal order ID
 */
export type CaptureOutcome =
  'completed' | 'already_handled' | 'pending' | 'failed' | 'unknown_order';

export interface PaymentServiceOptions {
  publicBaseUrl: string;
  brandName: string;
  policy: PaymentPolicyConfig;
}

/**
 * The trusted payment layer. It is only ever invoked by:
 *  - the confirmation executor (after an explicit merchant confirmation), and
 *  - verified PayPal webhooks / the PayPal return URL (status updates).
 * All amounts sent to PayPal come from the database, never from model output.
 */
export class PaymentService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly orders: OrderService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
    private readonly options: PaymentServiceOptions,
    private readonly inventory?: InventoryService,
  ) {}

  list(merchantId: string, options: { status?: PaymentStatus | undefined; limit?: number } = {}) {
    const limit = options.limit ?? 100;
    return this.db.payment.findMany({
      where: { merchantId, ...(options.status ? { status: options.status } : {}) },
      include: { order: { select: { reference: true, customer: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  /**
   * Creates a PayPal checkout order for a DRAFT order and returns the payment with its
   * approval URL. `idempotencyKey` (the confirmation ID) makes retries safe end to end:
   * the same key reuses the same Payment row and the same PayPal-Request-Id.
   */
  async createCheckout(order: OrderWithDetails, idempotencyKey: string): Promise<Payment> {
    const existing = await this.db.payment.findUnique({ where: { idempotencyKey } });
    if (existing?.checkoutUrl) return existing;

    if (order.status !== 'DRAFT') {
      throw new ConflictError(
        `Order ${order.reference} is ${order.status}; only draft orders can be sent for payment`,
      );
    }
    return this.openCheckout(order, idempotencyKey, existing, null);
  }

  /**
   * Replaces an expired PayPal checkout for an order still awaiting payment (used by payment
   * reminders). Same amount and items from the database; the old payment is cancelled first so
   * only one link is ever open. Idempotent per `idempotencyKey`.
   */
  async renewCheckout(
    order: OrderWithDetails,
    previous: Payment,
    idempotencyKey: string,
  ): Promise<Payment> {
    const existing = await this.db.payment.findUnique({ where: { idempotencyKey } });
    if (existing?.checkoutUrl) return existing;
    if (order.status !== 'AWAITING_PAYMENT') {
      throw new ConflictError(`Order ${order.reference} is ${order.status}; nothing to renew`);
    }
    await this.applyStatus(previous, 'CANCELLED');
    return this.openCheckout(order, idempotencyKey, existing, previous.id);
  }

  private async openCheckout(
    order: OrderWithDetails,
    idempotencyKey: string,
    existing: Payment | null,
    renewedFrom: string | null,
  ): Promise<Payment> {
    const decision = evaluatePaymentRequest(order, this.options.policy);
    if (!decision.allowed) throw new PolicyViolationError(decision.reason);

    const payment =
      existing ??
      (await this.db.payment.create({
        data: {
          merchantId: order.merchantId,
          orderId: order.id,
          provider: 'PAYPAL',
          kind: 'CHECKOUT_ORDER',
          status: 'CREATED',
          amountMinor: order.totalMinor,
          currency: order.currency,
          idempotencyKey,
          // Executed inside the transaction trace (see ConfirmationExecutor).
          correlationId: getContext()?.correlationId ?? null,
        },
      }));

    const major = (minor: number) => toMajorString(minor, order.currency);
    try {
      const { order: paypalOrder, approveUrl } = await this.paypal.createCheckoutOrder({
        requestId: idempotencyKey,
        referenceId: order.reference,
        customId: payment.id,
        description: `Order ${order.reference}`,
        currency: order.currency,
        items: order.items.map((i) => ({
          name: i.description,
          quantity: i.quantity,
          unitAmount: major(i.unitPriceMinor),
        })),
        itemTotal: major(order.subtotalMinor),
        shipping: major(order.shippingMinor),
        taxTotal: major(order.taxMinor),
        total: major(order.totalMinor),
        returnUrl: `${this.options.publicBaseUrl}/api/paypal/return`,
        cancelUrl: `${this.options.publicBaseUrl}/api/paypal/cancel`,
        brandName: this.options.brandName,
      });

      const updated = await this.db.$transaction(async (tx) => {
        const p = await tx.payment.update({
          where: { id: payment.id },
          data: {
            externalId: paypalOrder.id,
            checkoutUrl: approveUrl,
            providerStatus: paypalOrder.status,
          },
        });
        if (!renewedFrom) await this.orders.transition(order.id, 'DRAFT', 'AWAITING_PAYMENT', tx);
        await this.audit.record(
          {
            merchantId: order.merchantId,
            actor: 'SYSTEM',
            type: renewedFrom ? 'payment.link_renewed' : 'payment.requested',
            entityType: 'payment',
            entityId: payment.id,
            data: {
              ...(renewedFrom ? { renewedFrom } : {}),
              orderReference: order.reference,
              paypalOrderId: paypalOrder.id,
              paypalStatus: paypalOrder.status,
              amountMinor: order.totalMinor,
              currency: order.currency,
            },
          },
          tx,
        );
        return p;
      });
      return updated;
    } catch (error) {
      await this.db.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      await this.audit.record({
        merchantId: order.merchantId,
        actor: 'SYSTEM',
        type: 'payment.request_failed',
        entityType: 'payment',
        entityId: payment.id,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /**
   * Buyer approved the PayPal order. Called from the return URL (primary, works locally) and
   * from the CHECKOUT.ORDER.APPROVED webhook (deployed). Whichever arrives first captures;
   * the other is a no-op. Capture is idempotent three ways:
   *  1. local status check (only CREATED/APPROVED payments are captured),
   *  2. PayPal-Request-Id `capture-<paymentId>` (PayPal replays the original response),
   *  3. ORDER_ALREADY_CAPTURED → re-read the order from PayPal and sync.
   * `markCompleted` then guarantees a single status change and notification.
   */
  async captureApproved(paypalOrderId: string): Promise<CaptureOutcome> {
    const payment = await this.db.payment.findUnique({
      where: { provider_externalId: { provider: 'PAYPAL', externalId: paypalOrderId } },
    });
    if (!payment) return 'unknown_order';

    return this.inTransactionTrace(payment, async () => {
      if (payment.status !== 'CREATED' && payment.status !== 'APPROVED') return 'already_handled';

      let result: PayPalOrder;
      try {
        result = await this.paypal.captureOrder(paypalOrderId, `capture-${payment.id}`);
      } catch (error) {
        if (!payPalErrorIssues(error).includes('ORDER_ALREADY_CAPTURED')) throw error;
        this.logger.info({ paypalOrderId }, 'order already captured at PayPal; syncing status');
        result = await this.paypal.getOrder(paypalOrderId);
      }

      const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
      await this.db.payment.update({
        where: { id: payment.id },
        data: { providerStatus: result.status, ...(capture ? { captureId: capture.id } : {}) },
      });
      this.logger.info(
        {
          paypalOrderId,
          paypalStatus: result.status,
          captureId: capture?.id,
          captureStatus: capture?.status,
        },
        'paypal capture result',
      );

      if (capture?.status === 'COMPLETED') {
        return (await this.markCompleted(payment.id, capture.id)) ? 'completed' : 'already_handled';
      }
      if (capture?.status === 'DECLINED' || capture?.status === 'FAILED') {
        await this.applyStatus(payment, 'FAILED');
        return 'failed';
      }
      // e.g. capture PENDING: completion arrives later via PAYMENT.CAPTURE.COMPLETED.
      await this.applyStatus(payment, 'APPROVED');
      return 'pending';
    });
  }

  /**
   * Runs `fn` under the payment's transaction trace ID so that captures, webhooks and
   * notifications log/audit with the same correlation ID as the original agent request.
   */
  inTransactionTrace<T>(
    payment: Pick<Payment, 'correlationId' | 'merchantId'>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const current = getContext()?.correlationId;
    const traceId = payment.correlationId ?? current ?? newCorrelationId();
    if (current && current !== traceId) {
      this.logger.info({ traceId }, 'continuing transaction trace');
    }
    return runWithContext({ correlationId: traceId, merchantId: payment.merchantId }, fn);
  }

  /**
   * Marks a payment COMPLETED and its order PAID exactly once, then notifies the merchant.
   * Safe to call repeatedly (webhook redelivery, return URL + webhook racing).
   */
  async markCompleted(paymentId: string, captureId: string | undefined): Promise<boolean> {
    let stockAlerts: StockAlert[] = [];
    const firstTime = await this.db.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: ['CREATED', 'APPROVED'] } },
        data: {
          status: 'COMPLETED',
          providerStatus: 'COMPLETED',
          completedAt: new Date(),
          ...(captureId ? { captureId } : {}),
        },
      });
      if (count !== 1) return false;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      if (payment.order.status === 'AWAITING_PAYMENT') {
        await this.orders.transition(payment.orderId, 'AWAITING_PAYMENT', 'PAID', tx);
      }
      // A paid order reduces stock once (ledgered); alerts are sent after the commit.
      if (this.inventory) stockAlerts = await this.inventory.recordSale(payment.orderId, tx);
      await this.audit.record(
        {
          merchantId: payment.merchantId,
          actor: 'PROVIDER',
          type: 'payment.completed',
          entityType: 'payment',
          entityId: payment.id,
          data: { orderReference: payment.order.reference, captureId: captureId ?? null },
        },
        tx,
      );
      return true;
    });

    if (firstTime) {
      await this.notifyPaymentReceived(paymentId);
      if (stockAlerts.length) await this.notifyStockAlerts(paymentId, stockAlerts);
    }
    return firstTime;
  }

  /** Applies a non-completion status change if the state machine allows it. */
  async applyStatus(payment: Payment, to: PaymentStatus): Promise<boolean> {
    if (!canTransitionPayment(payment.status, to)) return false;
    const { count } = await this.db.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: { status: to },
    });
    if (count === 1) {
      await this.audit.record({
        merchantId: payment.merchantId,
        actor: 'PROVIDER',
        type: `payment.${to.toLowerCase()}`,
        entityType: 'payment',
        entityId: payment.id,
      });
    }
    return count === 1;
  }

  /** Audits a verified PayPal webhook under the payment's transaction trace. */
  recordWebhook(payment: Payment, event: { id: string; event_type: string }) {
    return this.inTransactionTrace(payment, () =>
      this.audit.record({
        merchantId: payment.merchantId,
        actor: 'PROVIDER',
        type: 'webhook.received',
        entityType: 'payment',
        entityId: payment.id,
        data: { eventType: event.event_type, eventId: event.id, signature: 'verified' },
      }),
    );
  }

  /** What a buyer may see about a checkout: merchant, order reference, amount, status. */
  async buyerView(paypalOrderId: string) {
    const payment = await this.db.payment.findUnique({
      where: { provider_externalId: { provider: 'PAYPAL', externalId: paypalOrderId } },
      include: {
        order: { select: { reference: true, status: true } },
        merchant: { select: { businessName: true } },
      },
    });
    if (!payment) return null;
    return {
      status: payment.status,
      orderStatus: payment.order.status,
      checkoutUrl: payment.checkoutUrl,
      details: {
        merchant: payment.merchant.businessName,
        reference: payment.order.reference,
        amount: formatMoney(payment.amountMinor, payment.currency),
      },
    };
  }

  findByProviderRefs(refs: { paypalOrderId?: string | undefined; customId?: string | undefined }) {
    if (refs.paypalOrderId) {
      return this.db.payment.findUnique({
        where: { provider_externalId: { provider: 'PAYPAL', externalId: refs.paypalOrderId } },
      });
    }
    if (refs.customId) return this.db.payment.findUnique({ where: { id: refs.customId } });
    return Promise.resolve(null);
  }

  /**
   * Low-stock / out-of-stock alerts after a sale: to every admin who opted in to alerts, or the
   * chat the order came from if no admin is set up for alerts.
   */
  private async notifyStockAlerts(paymentId: string, alerts: StockAlert[]): Promise<void> {
    const payment = await this.db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: { select: { conversationId: true } } },
    });
    const text = branded(alerts.map(formatStockAlert).join('\n\n'));
    const delivered = await this.notifications.toAdmins(payment.merchantId, text);
    if (!delivered && payment.order.conversationId)
      await this.notifications.toConversation(payment.order.conversationId, text);
  }

  private async notifyPaymentReceived(paymentId: string): Promise<void> {
    const payment = await this.db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: { include: { customer: true } } },
    });
    // Built only from trusted payment state; sent once (markCompleted's conditional update).
    const text = branded(
      [
        '✅ *Payment received*',
        '',
        `Order: ${payment.order.reference}`,
        `Customer: ${payment.order.customer.name}`,
        `Amount: ${formatMoney(payment.amountMinor, payment.currency)}`,
        '',
        'The order is now marked as paid.',
      ].join('\n'),
    );
    if (payment.order.conversationId) {
      await this.notifications.toConversation(payment.order.conversationId, text);
    }
  }
}

/** "⚠️ Low stock: Handmade Basket — 18 left (reorder level 30). Reply "restock …" when it arrives." */
export function formatStockAlert(a: StockAlert): string {
  return a.status === 'OUT_OF_STOCK'
    ? `⛔ *Out of stock:* ${a.name} (${a.stock} left).\nNew orders will warn that stock is short. Tell me when you restock, e.g. "add 50 ${a.name}".`
    : `⚠️ *Low stock:* ${a.name} — ${a.stock} left (reorder level ${a.reorderLevel}).\nTell me when you restock, e.g. "add 50 ${a.name}".`;
}
