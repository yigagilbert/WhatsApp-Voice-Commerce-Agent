import { formatMoney, toMinorUnits, type AuditService } from '@vca/commerce';
import type { Database, Payment } from '@vca/database';
import type { Logger } from '@vca/shared';
import type { PayPalApi } from '@vca/paypal';
import { branded } from '../agent/copy';
import type { NotificationService } from '../notifications/notification.service';
import type { PaymentService } from './payment.service';

export interface RefundSyncResult {
  /** Refunds recorded by this call (already-known refunds are not repeated). */
  added: { externalId: string; amountMinor: number; kind: 'refund' | 'reversal' }[];
  refundedMinor: number;
  /** The payment is now fully refunded (order REFUNDED). */
  full: boolean;
}

interface ReportedRefund {
  externalId: string;
  status: string;
  amountMinor: number;
  kind: 'refund' | 'reversal';
}

/**
 * Records refunds and reversals that happened at PayPal (Katale never initiates them) and keeps
 * payment, order and analytics consistent:
 *  - the refund list is re-read from PayPal (GET order), never taken from a webhook body;
 *  - one Refund row per PayPal refund ID, so redeliveries and reconciliation never double count;
 *  - partial refunds keep the payment COMPLETED / order PAID with `refundedMinor`; a full refund
 *    moves both to REFUNDED;
 *  - stock is never restocked automatically (the goods may be with the buyer): the merchant
 *    records a return when the items come back.
 */
export class RefundService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
    private readonly payments?: Pick<PaymentService, 'captureApproved' | 'recordLateCapture'>,
  ) {}

  async sync(payment: Payment): Promise<RefundSyncResult> {
    const externalId = payment.externalId;
    if (!externalId) return { added: [], refundedMinor: payment.refundedMinor, full: false };
    // A refund can be reported before Katale recorded the capture (lost webhook, buyer never
    // returned): record the payment first so the refund applies to a completed payment.
    if (this.payments && payment.status !== 'COMPLETED' && payment.status !== 'REFUNDED') {
      if (payment.status === 'CANCELLED') await this.payments.recordLateCapture(payment);
      else if (payment.status === 'CREATED' || payment.status === 'APPROVED')
        await this.payments.captureApproved(externalId);
      payment = await this.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    }
    const order = await this.paypal.getOrder(externalId);
    const unit = order.purchase_units?.[0];
    const reported: ReportedRefund[] = (unit?.payments?.refunds ?? [])
      .filter((r) => r.amount && r.amount.currency_code === payment.currency)
      .map((r) => ({
        externalId: r.id,
        status: r.status,
        amountMinor: toMinorUnits(r.amount!.value, payment.currency),
        kind: 'refund',
      }));
    // A reversal (e.g. a chargeback) has no refund entry: the capture itself says REVERSED.
    const capture = unit?.payments?.captures?.[0];
    if (capture?.status === 'REVERSED') {
      const refunded = reported
        .filter((r) => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + r.amountMinor, 0);
      const remaining = payment.amountMinor - refunded;
      if (remaining > 0)
        reported.push({
          externalId: `reversal:${capture.id}`,
          status: 'COMPLETED',
          amountMinor: remaining,
          kind: 'reversal',
        });
    }
    return this.apply(payment.id, reported);
  }

  private async apply(paymentId: string, reported: ReportedRefund[]): Promise<RefundSyncResult> {
    const added: RefundSyncResult['added'] = [];
    const result = await this.db.$transaction(async (tx) => {
      // Serialise refund bookkeeping per payment (webhook + reconciliation may race).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refunds:${paymentId}`}))`;
      // Same lock order as payment completion and cancellation: the order row first.
      await tx.$queryRaw`SELECT o.id FROM orders o JOIN payments p ON p."orderId" = o.id WHERE p.id = ${paymentId} FOR UPDATE OF o`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      for (const r of reported) {
        const existing = await tx.refund.findUnique({
          where: { provider_externalId: { provider: 'PAYPAL', externalId: r.externalId } },
        });
        if (existing) {
          if (existing.status !== r.status)
            await tx.refund.update({ where: { id: existing.id }, data: { status: r.status } });
          if (existing.status !== 'COMPLETED' && r.status === 'COMPLETED')
            added.push({ externalId: r.externalId, amountMinor: r.amountMinor, kind: r.kind });
          continue;
        }
        await tx.refund.create({
          data: {
            merchantId: payment.merchantId,
            orderId: payment.orderId,
            paymentId: payment.id,
            provider: 'PAYPAL',
            externalId: r.externalId,
            amountMinor: r.amountMinor,
            currency: payment.currency,
            status: r.status,
            kind: r.kind,
          },
        });
        if (r.status === 'COMPLETED')
          added.push({ externalId: r.externalId, amountMinor: r.amountMinor, kind: r.kind });
      }
      const total = await tx.refund.aggregate({
        where: { paymentId, status: 'COMPLETED' },
        _sum: { amountMinor: true },
      });
      const refundedMinor = Math.min(total._sum.amountMinor ?? 0, payment.amountMinor);
      const full = refundedMinor >= payment.amountMinor && refundedMinor > 0;
      if (refundedMinor === payment.refundedMinor && (!full || payment.status === 'REFUNDED'))
        return { refundedMinor, full, changed: false, payment };

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          refundedMinor,
          ...(full && payment.status === 'COMPLETED' ? { status: 'REFUNDED' } : {}),
        },
      });
      // Order totals follow the sum over all its payments (normally one).
      if (payment.duplicate) {
        // Refunding an extra payment doesn't refund the order. Once every extra payment is fully
        // refunded, the order no longer needs review for it.
        const unrefunded = await tx.payment.count({
          where: { orderId: payment.orderId, duplicate: true, status: 'COMPLETED' },
        });
        if (full && unrefunded === 0 && payment.order.attention === 'DUPLICATE_PAYMENT')
          await tx.order.update({
            where: { id: payment.orderId },
            data: { attention: null, attentionAt: null },
          });
      } else {
        // Order totals follow the refunds of the payments that paid it (not extra payments).
        const orderRefunds = await tx.refund.aggregate({
          where: { orderId: payment.orderId, status: 'COMPLETED', payment: { duplicate: false } },
          _sum: { amountMinor: true },
        });
        const orderRefunded = Math.min(
          orderRefunds._sum.amountMinor ?? 0,
          payment.order.totalMinor,
        );
        await tx.order.update({
          where: { id: payment.orderId },
          data: {
            refundedMinor: orderRefunded,
            ...(orderRefunded >= payment.order.totalMinor && payment.order.status === 'PAID'
              ? { status: 'REFUNDED' }
              : {}),
          },
        });
      }
      await this.audit.record(
        {
          merchantId: payment.merchantId,
          actor: 'PROVIDER',
          type: full ? 'payment.refunded' : 'payment.partially_refunded',
          entityType: 'payment',
          entityId: payment.id,
          data: {
            orderReference: payment.order.reference,
            refundedMinor,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            refunds: added.map((a) => a.externalId),
          },
        },
        tx,
      );
      return { refundedMinor, full, changed: true, payment };
    });

    if (result.changed && added.length) {
      const newly = added.reduce((sum, a) => sum + a.amountMinor, 0);
      await this.notify(result.payment, result.refundedMinor, newly, result.full).catch(
        (error: unknown) =>
          this.logger.warn({ err: error, paymentId }, 'refund notification failed'),
      );
    }
    return { added, refundedMinor: result.refundedMinor, full: result.full };
  }

  private async notify(
    payment: Payment & { order: { id: string } },
    refundedMinor: number,
    newlyRefundedMinor: number,
    full: boolean,
  ) {
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: payment.order.id },
      include: { customer: true },
    });
    const money = (m: number) => formatMoney(m, payment.currency);
    if (payment.duplicate) {
      await this.notifications.toAdmins(
        payment.merchantId,
        branded(
          `↩️ The extra payment for order ${order.reference} (${order.customer.name}) was refunded: ${money(refundedMinor)} of ${money(payment.amountMinor)}. The order itself stays paid.`,
        ),
      );
      if (order.placedBy === 'CUSTOMER' && order.conversationId)
        await this.notifications.toConversation(
          order.conversationId,
          `↩️ Your extra payment of ${money(newlyRefundedMinor)} for order ${order.reference} was refunded to your PayPal account. Your order is still paid.`,
        );
      return;
    }
    const fulfilment =
      order.fulfillmentStatus === 'SHIPPED'
        ? 'It was already shipped. Stock was not changed: if the items come back, tell me (e.g. "2 baskets returned").'
        : full
          ? 'Do not ship this order.'
          : 'The order stays paid; check with the customer what to send.';
    await this.notifications.toAdmins(
      payment.merchantId,
      branded(
        [
          full ? '↩️ *Order refunded*' : '↩️ *Partial refund*',
          '',
          `Order: ${order.reference} (${order.customer.name})`,
          `Refunded: ${money(refundedMinor)} of ${money(payment.amountMinor)}`,
          '',
          fulfilment,
        ].join('\n'),
      ),
    );
    if (order.placedBy === 'CUSTOMER' && order.conversationId)
      await this.notifications.toConversation(
        order.conversationId,
        `↩️ A refund of ${money(newlyRefundedMinor)} for order ${order.reference} was sent to your PayPal account.`,
      );
  }
}
