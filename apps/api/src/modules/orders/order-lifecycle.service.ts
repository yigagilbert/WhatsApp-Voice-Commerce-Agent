import { formatMoney, type AuditService } from '@vca/commerce';
import type { Database, Order, OrderCancelReason, Payment } from '@vca/database';
import { ProviderError, type Logger } from '@vca/shared';
import { payPalErrorStatus, type PayPalApi } from '@vca/paypal';
import { branded } from '../agent/copy';
import type { NotificationService } from '../notifications/notification.service';
import type { PaymentService } from '../payments/payment.service';

const MINUTE = 60_000;
/** PayPal checkouts younger than this may still be being created (see ShopOrderService.claim). */
const ATTEMPT_IN_FLIGHT_MS = 2 * MINUTE;
/** Orders handled per expiry pass (one pass per scheduler minute). */
const EXPIRY_BATCH = 20;

/** PayPal order states where the buyer can still pay; anything else means no money will come. */
const STILL_PAYABLE = new Set(['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED']);

/** Unpaid = awaiting payment, or placed by a customer and waiting for the owner's approval. */
const UNPAID = {
  OR: [
    { status: 'AWAITING_PAYMENT' as const },
    { status: 'DRAFT' as const, placedBy: 'CUSTOMER' as const, customerConfirmedAt: { not: null } },
  ],
};

export type CancelOutcome =
  | { status: 'cancelled'; order: Order }
  | { status: 'already_cancelled'; order: Order }
  /** The buyer paid before the cancellation could happen: the order is now PAID. */
  | { status: 'paid'; order: Order }
  | { status: 'not_cancellable'; order: Order; reason: string };

type OpenPayment = Pick<Payment, 'id' | 'externalId' | 'status' | 'createdAt'>;

/**
 * Ends unpaid orders: merchant and customer cancellations and automatic expiry.
 *
 * Money safety: before an order with an open PayPal link is cancelled, PayPal is asked about it.
 * If the buyer already approved or paid, the payment is captured/recorded instead and the order
 * stays (or becomes) PAID. The cancellation itself is a conditional update, so concurrent
 * cancellations, expiry passes and payments can't both win; a capture that still races past it
 * is recorded by PaymentService.markCompleted, which reinstates the order. Reserved stock is
 * derived from order status, so a cancelled order releases it immediately.
 */
export class OrderLifecycleService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  /**
   * Cancels an unpaid order. `customerId` restricts it to that customer's own orders. Throws
   * ProviderError if PayPal can't be asked whether an open link was paid (try again later).
   */
  async cancel(params: {
    merchantId: string;
    reference: string;
    by: 'MERCHANT' | 'CUSTOMER';
    customerId?: string;
    actorLabel?: string;
  }): Promise<CancelOutcome | null> {
    const ref = params.reference.trim().toUpperCase();
    const order = await this.db.order.findFirst({
      where: {
        merchantId: params.merchantId,
        OR: [{ reference: ref }, { id: params.reference.trim() }],
        ...(params.customerId ? { customerId: params.customerId } : {}),
      },
    });
    if (!order) return null;
    return this.end(order, params.by, params.actorLabel);
  }

  /**
   * Expiry pass: cancels unpaid orders past their payment due time (oldest first, a batch at a
   * time). Orders created before due times existed get a full window from now instead of being
   * cancelled on the first run. Returns the references that were cancelled.
   */
  async expireDue(expiryHours: number, now = new Date()): Promise<string[]> {
    if (expiryHours <= 0) return [];
    await this.db.order.updateMany({
      where: { ...UNPAID, paymentDueAt: null },
      data: { paymentDueAt: new Date(now.getTime() + expiryHours * 3_600_000) },
    });
    const due = await this.db.order.findMany({
      where: { ...UNPAID, paymentDueAt: { lte: now } },
      orderBy: { paymentDueAt: 'asc' },
      take: EXPIRY_BATCH,
    });
    const expired: string[] = [];
    for (const order of due) {
      try {
        const outcome = await this.end(order, 'SYSTEM');
        if (outcome.status === 'cancelled') expired.push(order.reference);
      } catch (error) {
        // PayPal unreachable or a payment attempt in flight: try again on a later pass.
        this.logger.warn({ err: error, orderId: order.id }, 'order expiry deferred');
      }
    }
    return expired;
  }

  private async end(
    order: Order,
    by: 'MERCHANT' | 'CUSTOMER' | 'SYSTEM',
    actorLabel?: string,
  ): Promise<CancelOutcome> {
    if (order.status === 'CANCELLED') return { status: 'already_cancelled', order };
    if (order.status === 'PAID' || order.status === 'REFUNDED')
      return {
        status: 'not_cancellable',
        order,
        reason:
          order.status === 'PAID'
            ? 'This order is already paid. Refund it in PayPal if needed; Katale records the refund automatically.'
            : 'This order was refunded.',
      };
    if (by === 'CUSTOMER' && order.placedBy === 'CUSTOMER' && !order.customerConfirmedAt)
      return { status: 'not_cancellable', order, reason: 'This is your cart, not an order.' };

    // 1. Ask PayPal about every open link first: paid or approved means no cancellation.
    const open = await this.db.payment.findMany({
      where: { orderId: order.id, status: { in: ['CREATED', 'APPROVED'] } },
      select: { id: true, externalId: true, status: true, createdAt: true },
    });
    for (const payment of open) {
      if (await this.paidAtProvider(payment)) {
        const fresh = await this.db.order.findUniqueOrThrow({ where: { id: order.id } });
        if (fresh.status === 'PAID') return { status: 'paid', order: fresh };
        // Approved but the capture is still pending at PayPal: leave the order alone for now.
        throw new ProviderError('paypal', 'payment is being completed; try again shortly');
      }
    }

    // 2. Cancel atomically: only if the order is still in the status we looked at.
    const reason: OrderCancelReason =
      by === 'SYSTEM' ? 'PAYMENT_EXPIRED' : by === 'MERCHANT' ? 'MERCHANT' : 'CUSTOMER';
    const cancelled = await this.db.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
      });
      if (count !== 1) return false;
      await tx.payment.updateMany({
        where: { orderId: order.id, status: { in: ['CREATED', 'APPROVED'] } },
        data: { status: 'CANCELLED' },
      });
      // A pending "CONFIRM" for this order's payment request must not run any more.
      await tx.actionConfirmation.updateMany({
        where: {
          merchantId: order.merchantId,
          status: 'PENDING',
          payload: { path: ['orderId'], equals: order.id },
        },
        data: { status: 'CANCELLED' },
      });
      await this.audit.record(
        {
          merchantId: order.merchantId,
          actor: by === 'MERCHANT' ? 'MERCHANT' : 'SYSTEM',
          type: by === 'SYSTEM' ? 'order.expired' : 'order.cancelled',
          entityType: 'order',
          entityId: order.id,
          data: {
            reference: order.reference,
            previousStatus: order.status,
            reason,
            ...(by === 'CUSTOMER' ? { by: 'customer' } : {}),
            ...(actorLabel ? { actor: actorLabel } : {}),
          },
        },
        tx,
      );
      return true;
    });
    const current = await this.db.order.findUniqueOrThrow({ where: { id: order.id } });
    if (!cancelled) {
      if (current.status === 'CANCELLED') return { status: 'already_cancelled', order: current };
      if (current.status === 'PAID') return { status: 'paid', order: current };
      return { status: 'not_cancellable', order: current, reason: 'The order changed; try again.' };
    }
    await this.notify(current, by).catch((error: unknown) =>
      this.logger.warn({ err: error, orderId: order.id }, 'cancellation notice failed'),
    );
    return { status: 'cancelled', order: current };
  }

  /**
   * True if the buyer approved or paid this link (and records the payment if so). A link still
   * being created is treated as "can't tell yet" (ProviderError) rather than cancelled under it.
   */
  private async paidAtProvider(payment: OpenPayment): Promise<boolean> {
    if (!payment.externalId) {
      if (Date.now() - payment.createdAt.getTime() < ATTEMPT_IN_FLIGHT_MS)
        throw new ProviderError('paypal', 'payment link is still being created');
      return false;
    }
    if (!this.paypal.configured) return false;
    let status: string;
    try {
      status = (await this.paypal.getOrder(payment.externalId)).status;
    } catch (error) {
      if (payPalErrorStatus(error) === 404) return false;
      throw error instanceof ProviderError
        ? error
        : new ProviderError('paypal', 'could not check the payment', { cause: error });
    }
    if (STILL_PAYABLE.has(status) || status === 'VOIDED') return false;
    if (status === 'APPROVED' || status === 'COMPLETED') {
      await this.payments.captureApproved(payment.externalId);
      return true;
    }
    return false;
  }

  private async notify(order: Order, by: 'MERCHANT' | 'CUSTOMER' | 'SYSTEM') {
    const total = formatMoney(order.totalMinor, order.currency);
    const customer = await this.db.customer.findUnique({ where: { id: order.customerId } });
    const who = customer?.name ?? 'customer';
    if (order.placedBy === 'CUSTOMER' && order.conversationId && by !== 'CUSTOMER') {
      await this.notifications.toConversation(
        order.conversationId,
        by === 'SYSTEM'
          ? `Order ${order.reference} (${total}) was cancelled because it wasn't paid in time. No money was taken. Reply *1* to shop again.`
          : `Order ${order.reference} (${total}) was cancelled by the shop. No money was taken. Reply *4* if you have questions.`,
      );
    }
    if (by === 'MERCHANT') return; // the merchant did it themselves
    await this.notifications.toAdmins(
      order.merchantId,
      branded(
        by === 'SYSTEM'
          ? `⌛ Order ${order.reference} (${who}, ${total}) was cancelled: not paid in time. Its stock is available again.`
          : `❌ ${who} cancelled order ${order.reference} (${total}). Its stock is available again.`,
      ),
    );
  }
}
