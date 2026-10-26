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
import type { OpsAlerts } from '../ops/ops-alerts';

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
  /** Hours an order may wait for payment before it is cancelled (0 = never). */
  unpaidOrderExpiryHours?: number;
  /** Operator alert when PayPal refuses or fails to create a payment link. */
  alerts?: Pick<OpsAlerts, 'alert'>;
}

/** Captured money as PayPal reports it (major-unit string), to check against what we asked for. */
export interface CapturedAmount {
  value: string;
  currency: string;
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
        // A new link (or a renewed one the merchant asked for) gets a full payment window.
        const dueAt = this.paymentDueAt();
        if (dueAt)
          await tx.order.updateMany({
            where: {
              id: order.id,
              OR: [{ paymentDueAt: null }, { paymentDueAt: { lt: dueAt } }],
            },
            data: { paymentDueAt: dueAt },
          });
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
      // Policy refusals are expected business outcomes; provider failures need a look.
      if (!(error instanceof PolicyViolationError))
        await this.options.alerts?.alert(
          'paypal-checkout-failed',
          'PayPal payment link failed',
          `A payment link for order ${order.reference} could not be created: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}\nThe customer/merchant can retry; check PayPal status and credentials if this repeats.`,
        );
      throw error;
    }
  }

  /** When an order sent for payment now must be paid by (null when expiry is off). */
  paymentDueAt(now = new Date()): Date | null {
    const hours = this.options.unpaidOrderExpiryHours ?? 0;
    return hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
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
        const amount = capture.amount
          ? { value: capture.amount.value, currency: capture.amount.currency_code }
          : undefined;
        return (await this.markCompleted(payment.id, capture.id, amount))
          ? 'completed'
          : 'already_handled';
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
   *
   * Money that arrives for a CANCELLED payment (a capture that raced a cancellation, or an old,
   * superseded link) is still recorded: a cancelled order is reinstated as PAID, and a second
   * payment for an already-paid order is flagged to the admins for a refund.
   */
  async markCompleted(
    paymentId: string,
    captureId: string | undefined,
    captured?: CapturedAmount,
  ): Promise<boolean> {
    let stockAlerts: StockAlert[] = [];
    let outcome: 'paid' | 'reinstated' | 'duplicate' = 'paid';
    const firstTime = await this.db.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: ['CREATED', 'APPROVED', 'CANCELLED'] } },
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
      const order = payment.order;
      if (order.status === 'AWAITING_PAYMENT') {
        await this.orders.transition(order.id, 'AWAITING_PAYMENT', 'PAID', tx);
      } else if (order.status === 'CANCELLED') {
        await this.orders.transition(order.id, 'CANCELLED', 'PAID', tx);
        await tx.order.update({
          where: { id: order.id },
          data: { cancelledAt: null, cancelReason: null },
        });
        outcome = 'reinstated';
        await this.audit.record(
          {
            merchantId: payment.merchantId,
            actor: 'PROVIDER',
            type: 'order.reinstated',
            entityType: 'order',
            entityId: order.id,
            data: { reference: order.reference, cancelReason: order.cancelReason },
          },
          tx,
        );
      } else {
        outcome = 'duplicate';
      }
      // A paid order reduces stock once (ledgered); alerts are sent after the commit.
      if (this.inventory && outcome !== 'duplicate')
        stockAlerts = await this.inventory.recordSale(order.id, tx);
      const mismatch = captured && !this.matches(payment, captured);
      await this.audit.record(
        {
          merchantId: payment.merchantId,
          actor: 'PROVIDER',
          type: 'payment.completed',
          entityType: 'payment',
          entityId: payment.id,
          data: {
            orderReference: order.reference,
            captureId: captureId ?? null,
            ...(outcome !== 'paid' ? { note: outcome } : {}),
            ...(mismatch
              ? { capturedAmount: captured.value, capturedCurrency: captured.currency }
              : {}),
          },
        },
        tx,
      );
      if (mismatch)
        await this.audit.record(
          {
            merchantId: payment.merchantId,
            actor: 'PROVIDER',
            type: 'payment.amount_mismatch',
            entityType: 'payment',
            entityId: payment.id,
            data: {
              expected: toMajorString(payment.amountMinor, payment.currency),
              expectedCurrency: payment.currency,
              captured: captured.value,
              capturedCurrency: captured.currency,
            },
          },
          tx,
        );
      return true;
    });

    if (firstTime) {
      if (outcome === 'duplicate') await this.notifyDuplicatePayment(paymentId);
      else await this.notifyPaymentReceived(paymentId, outcome === 'reinstated');
      if (stockAlerts.length) await this.notifyStockAlerts(paymentId, stockAlerts);
    }
    return firstTime;
  }

  private matches(payment: Pick<Payment, 'amountMinor' | 'currency'>, captured: CapturedAmount) {
    return (
      captured.currency === payment.currency &&
      captured.value === toMajorString(payment.amountMinor, payment.currency)
    );
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

  findByCaptureId(captureId: string) {
    return this.db.payment.findFirst({ where: { provider: 'PAYPAL', captureId } });
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
      include: { order: { select: { conversationId: true, placedBy: true } } },
    });
    const text = branded(alerts.map(formatStockAlert).join('\n\n'));
    const delivered = await this.notifications.toAdmins(payment.merchantId, text);
    // Fallback to the order's chat only for merchant orders: a customer order's chat is the
    // customer's, and stock levels are business information.
    if (!delivered && payment.order.conversationId && payment.order.placedBy === 'MERCHANT')
      await this.notifications.toConversation(payment.order.conversationId, text);
  }

  private async notifyDuplicatePayment(paymentId: string): Promise<void> {
    const payment = await this.db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: { include: { customer: true } } },
    });
    await this.notifications.toAdmins(
      payment.merchantId,
      branded(
        [
          '⚠️ *Second payment received*',
          '',
          `Order ${payment.order.reference} (${payment.order.customer.name}) was already paid, and another ${formatMoney(payment.amountMinor, payment.currency)} arrived through an older payment link.`,
          'Please refund the extra payment in PayPal.',
        ].join('\n'),
      ),
    );
  }

  private async notifyPaymentReceived(paymentId: string, reinstated = false): Promise<void> {
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
        reinstated
          ? 'This order had been cancelled, but the payment went through, so it is marked as paid again. Please check stock before you fulfil it, or refund it in PayPal.'
          : 'The order is now marked as paid.',
      ].join('\n'),
    );
    if (payment.order.placedBy === 'CUSTOMER') {
      // The order's chat is the customer's: thank them there, and tell the shop's admins.
      if (payment.order.conversationId)
        await this.notifications.toConversation(
          payment.order.conversationId,
          [
            `✅ *Payment received — thank you!*`,
            '',
            `Order ${payment.order.reference} · ${formatMoney(payment.amountMinor, payment.currency)} is paid.`,
            payment.order.deliveryMethod === 'PICKUP'
              ? "We'll let you know when it's ready to pick up."
              : "We're preparing it now. Reply *orders* any time to check its status.",
          ].join('\n'),
        );
      await this.notifications.toAdmins(payment.merchantId, text);
      return;
    }
    if (payment.order.conversationId) {
      await this.notifications.toConversation(payment.order.conversationId, text);
    }
    // A reinstated order needs a decision (fulfil or refund): make sure the admins see it.
    if (reinstated && !payment.order.conversationId)
      await this.notifications.toAdmins(payment.merchantId, text);
  }
}

/** "⚠️ Low stock: Handmade Basket — 18 left (reorder level 30). Reply "restock …" when it arrives." */
export function formatStockAlert(a: StockAlert): string {
  return a.status === 'OUT_OF_STOCK'
    ? `⛔ *Out of stock:* ${a.name} (${a.stock} left).\nNew orders will warn that stock is short. Tell me when you restock, e.g. "add 50 ${a.name}".`
    : `⚠️ *Low stock:* ${a.name} — ${a.stock} left (reorder level ${a.reorderLevel}).\nTell me when you restock, e.g. "add 50 ${a.name}".`;
}
