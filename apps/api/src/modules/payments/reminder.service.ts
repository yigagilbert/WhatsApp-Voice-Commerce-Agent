import {
  chatIdToPhone,
  formatMoney,
  normalizePhone,
  phoneToChatId,
  type AuditService,
  type OrderService,
} from '@vca/commerce';
import type { Customer, Database, Merchant, Payment } from '@vca/database';
import { payPalErrorStatus, type PayPalApi } from '@vca/paypal';
import { ConflictError, ValidationError, type Logger } from '@vca/shared';
import { z } from 'zod';
import type { NotificationService } from '../notifications/notification.service';
import type { PaymentService } from './payment.service';

/** At most one reminder per payment link per day, and three in total. */
export const REMINDER_MIN_INTERVAL_HOURS = 24;
export const MAX_REMINDERS = 3;
const HOUR = 3_600_000;
/** PayPal order states in which the buyer can still pay through the existing link. */
const PAYABLE = new Set(['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED']);

/** What a REMIND confirmation is bound to (hashed with the confirmation). */
export const reminderPayloadSchema = z.object({
  orderId: z.string(),
  orderReference: z.string(),
  paymentId: z.string(),
  customerName: z.string(),
  chatId: z.string(),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
});
export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

export type ReminderOutcome =
  | { status: 'sent'; renewed: boolean; reminderNumber: number; link: string }
  /** PayPal showed the buyer had already paid/approved: captured and recorded instead. */
  | { status: 'paid' }
  /** Buyer approved; PayPal is still completing the capture. */
  | { status: 'pending' };

type Order = Awaited<ReturnType<OrderService['getByReference']>>;

/**
 * Merchant-approved payment reminders: a polite WhatsApp message to the customer with the
 * PayPal link for an order still awaiting payment. Before sending, PayPal is asked for the
 * link's status: already-paid orders are captured instead of reminded, and expired links are
 * replaced (same amount, from the database). Rate limited per payment link.
 */
export class PaymentReminderService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly defaultRegion = 'UG',
  ) {}

  /** The customer's WhatsApp chat: their WhatsApp ID, else their phone number. */
  chatFor(customer: Pick<Customer, 'whatsappId' | 'phone'>): string | null {
    if (customer.whatsappId) return customer.whatsappId;
    if (!customer.phone) return null;
    try {
      return phoneToChatId(normalizePhone(customer.phone, this.defaultRegion));
    } catch {
      return null;
    }
  }

  /** The message the customer receives. */
  static message(p: {
    customerName: string;
    business: string;
    reference: string;
    amount: string;
    link: string;
  }): string {
    return [
      `Hello ${p.customerName} 👋`,
      '',
      `A friendly reminder from *${p.business}*: order ${p.reference} (*${p.amount}*) is still awaiting payment.`,
      '',
      'Pay securely with PayPal:',
      p.link,
      '',
      "If you've already paid, please ignore this message. Thank you!",
    ].join('\n');
  }

  private assertCanRemind(payment: Payment, now: Date) {
    if (payment.reminderCount >= MAX_REMINDERS) {
      throw new ConflictError(
        `${MAX_REMINDERS} reminders have already been sent for this payment. Contact the customer directly.`,
      );
    }
    if (
      payment.lastReminderAt &&
      now.getTime() - payment.lastReminderAt.getTime() < REMINDER_MIN_INTERVAL_HOURS * HOUR
    ) {
      const hours = Math.max(
        1,
        Math.round((now.getTime() - payment.lastReminderAt.getTime()) / HOUR),
      );
      throw new ConflictError(
        `A reminder was already sent ${hours} hour${hours === 1 ? '' : 's'} ago. Reminders are limited to one every ${REMINDER_MIN_INTERVAL_HOURS} hours.`,
      );
    }
  }

  private openPayment(order: Order): Payment {
    const payment = order.payments[0];
    if (order.status === 'PAID') throw new ConflictError(`${order.reference} is already paid.`);
    if (
      order.status !== 'AWAITING_PAYMENT' ||
      !payment ||
      (payment.status !== 'CREATED' && payment.status !== 'APPROVED') ||
      !payment.externalId
    ) {
      throw new ConflictError(
        `${order.reference} has no open payment link (status ${order.status.toLowerCase().replace('_', ' ')}). Only orders awaiting payment can be reminded.`,
      );
    }
    return payment;
  }

  /** Validates a reminder and returns what the merchant approves. Sends nothing. */
  async prepare(
    merchant: Pick<Merchant, 'id' | 'businessName'>,
    orderReference: string,
    now = new Date(),
  ) {
    const order = await this.orders.getByReference(merchant.id, orderReference);
    const payment = this.openPayment(order);
    this.assertCanRemind(payment, now);
    const chatId = this.chatFor(order.customer);
    if (!chatId) {
      throw new ValidationError(
        `${order.customer.name} has no WhatsApp number on file. Add their phone number to the customer, then try again.`,
      );
    }
    const payload: ReminderPayload = {
      orderId: order.id,
      orderReference: order.reference,
      paymentId: payment.id,
      customerName: order.customer.name,
      chatId,
      amountMinor: order.totalMinor,
      currency: order.currency,
    };
    const age = Math.floor((now.getTime() - payment.createdAt.getTime()) / (24 * HOUR));
    const summary = [
      '*Payment reminder*',
      '',
      `To: ${order.customer.name} (${chatIdToPhone(chatId) ?? 'WhatsApp'})`,
      `Order: ${order.reference} · ${formatMoney(order.totalMinor, order.currency)} · link sent ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}`,
      `Reminders so far: ${payment.reminderCount} of ${MAX_REMINDERS}`,
      '',
      'Message:',
      PaymentReminderService.message({
        customerName: order.customer.name,
        business: merchant.businessName,
        reference: order.reference,
        amount: formatMoney(order.totalMinor, order.currency),
        link: '<PayPal payment link>',
      })
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    ].join('\n');
    return { payload, summary, order };
  }

  /**
   * Sends an approved reminder (REMIND <code> on WhatsApp, or the dashboard button). Re-checks
   * everything against the database and PayPal first.
   */
  async send(
    merchant: Pick<Merchant, 'id' | 'businessName'>,
    payload: ReminderPayload,
    via: 'whatsapp' | 'dashboard',
    now = new Date(),
  ): Promise<ReminderOutcome> {
    const order = await this.orders.getByReference(merchant.id, payload.orderId);
    if (order.status === 'PAID') return { status: 'paid' };
    let payment = this.openPayment(order);
    if (payment.id !== payload.paymentId || order.totalMinor !== payload.amountMinor) {
      throw new ConflictError(
        `${order.reference} changed since the reminder was prepared. Please ask again.`,
      );
    }
    if (this.chatFor(order.customer) !== payload.chatId) {
      throw new ConflictError(
        `${order.customer.name}'s WhatsApp number changed. Please ask again.`,
      );
    }
    this.assertCanRemind(payment, now);

    // Is the link still payable? Never remind a customer who already paid, or send a dead link.
    let expired = false;
    try {
      const paypalOrder = await this.paypal.getOrder(payment.externalId!);
      if (paypalOrder.status === 'APPROVED' || paypalOrder.status === 'COMPLETED') {
        const outcome = await this.payments.captureApproved(payment.externalId!);
        if (outcome === 'completed' || outcome === 'already_handled') return { status: 'paid' };
        if (outcome === 'pending') return { status: 'pending' };
        expired = true; // capture declined: the buyer needs a fresh link
      } else if (!PAYABLE.has(paypalOrder.status)) {
        expired = true; // e.g. VOIDED
      }
    } catch (error) {
      if (payPalErrorStatus(error) !== 404) throw error;
      expired = true; // PayPal no longer knows the order: the link expired
    }

    if (expired) {
      const previous = payment;
      const renewed = await this.payments.renewCheckout(
        order,
        previous,
        `renew-${previous.id}-${previous.reminderCount}`,
      );
      payment = await this.db.payment.update({
        where: { id: renewed.id },
        data: { reminderCount: previous.reminderCount, lastReminderAt: previous.lastReminderAt },
      });
    }

    // Claim the reminder slot atomically, so a double click or a replay never sends twice.
    const cutoff = new Date(now.getTime() - REMINDER_MIN_INTERVAL_HOURS * HOUR);
    const claimed = await this.db.payment.updateMany({
      where: {
        id: payment.id,
        reminderCount: { lt: MAX_REMINDERS },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: cutoff } }],
      },
      data: { reminderCount: { increment: 1 }, lastReminderAt: now },
    });
    if (claimed.count !== 1) throw new ConflictError('A reminder for this payment was just sent.');

    const link = payment.checkoutUrl!;
    const delivered = await this.notifications.toCustomer(
      { ...order.customer, whatsappId: payload.chatId },
      PaymentReminderService.message({
        customerName: order.customer.name,
        business: merchant.businessName,
        reference: order.reference,
        amount: formatMoney(order.totalMinor, order.currency),
        link,
      }),
    );
    if (!delivered) {
      // Give the slot back: nothing reached the customer.
      await this.db.payment.update({
        where: { id: payment.id },
        data: { reminderCount: payment.reminderCount, lastReminderAt: payment.lastReminderAt },
      });
      throw new ConflictError(
        `The reminder couldn't be delivered on WhatsApp. Check that the bot is connected (dashboard → WhatsApp) and that ${order.customer.name}'s number is on WhatsApp.`,
      );
    }
    const reminderNumber = payment.reminderCount + 1;
    await this.audit.record({
      merchantId: merchant.id,
      actor: via === 'dashboard' ? 'MERCHANT' : 'SYSTEM',
      type: 'payment.reminder_sent',
      entityType: 'payment',
      entityId: payment.id,
      data: { orderReference: order.reference, reminderNumber, renewedLink: expired, via },
    });
    this.logger.info(
      { orderReference: order.reference, reminderNumber, renewed: expired },
      'payment reminder sent',
    );
    return { status: 'sent', renewed: expired, reminderNumber, link };
  }
}
