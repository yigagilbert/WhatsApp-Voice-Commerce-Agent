import { formatMoney, type AuditService } from '@vca/commerce';
import type { Database, Payment } from '@vca/database';
import { payPalErrorStatus, type PayPalApi } from '@vca/paypal';
import type { Logger } from '@vca/shared';
import type { PaymentService } from './payment.service';

const MINUTE = 60_000;
/** A link younger than this is left alone: the buyer may be paying right now. */
const MIN_AGE_MS = 30 * MINUTE;
/** Each open link is re-checked with PayPal at most this often in the background. */
const RECHECK_MS = 6 * 60 * MINUTE;
/** PayPal calls per background pass (one pass per scheduler minute). */
const SWEEP_BATCH = 10;

export interface ReconciliationResult {
  checked: number;
  /** Paid at PayPal but not yet recorded in Katale (e.g. a lost webhook): now recorded. */
  recovered: { reference: string; amount: string }[];
  /** Approved by the buyer; PayPal is still completing the capture. */
  pending: string[];
  /** Links PayPal no longer accepts (the order needs a fresh link: a reminder sends one). */
  expired: string[];
  /** Internal inconsistencies between orders and payments (should never happen). */
  mismatches: string[];
  /** PayPal could not be reached for these links; they are retried later. */
  errors: number;
}

const PAYABLE = new Set(['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED']);

/**
 * Cancelled links are re-checked this long after cancellation: a capture racing the cancellation
 * whose webhook was lost would otherwise never be recorded. (They are never captured by us.)
 */
const CANCELLED_WATCH_MS = 3 * 24 * 60 * MINUTE;

/** Open links, plus links cancelled recently enough that money might still have arrived. */
const watched = (now: Date) => ({
  externalId: { not: null },
  OR: [
    { status: { in: ['CREATED' as const, 'APPROVED' as const] } },
    {
      status: 'CANCELLED' as const,
      updatedAt: { gt: new Date(now.getTime() - CANCELLED_WATCH_MS) },
    },
  ],
});

/**
 * Makes sure sales recorded in Katale match PayPal. Open payment links are re-checked with
 * PayPal (GET order): money that arrived without a webhook is captured/recorded through the
 * normal idempotent path, and expired links are flagged. Orders and payments are also checked
 * for consistency. Read-mostly: the only writes are the same ones a webhook would make.
 */
export class PaymentReconciler {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly payments: PaymentService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  /** Background pass: a few open links that haven't been checked recently (all merchants). */
  async sweep(now = new Date(), options: { merchantId?: string } = {}): Promise<void> {
    if (!this.paypal.configured) return;
    const due = await this.db.payment.findMany({
      where: {
        ...(options.merchantId ? { merchantId: options.merchantId } : {}),
        createdAt: { lt: new Date(now.getTime() - MIN_AGE_MS) },
        AND: [
          watched(now),
          {
            OR: [
              { providerCheckedAt: null },
              { providerCheckedAt: { lt: new Date(now.getTime() - RECHECK_MS) } },
            ],
          },
        ],
      },
      include: { order: { select: { reference: true, status: true } } },
      orderBy: [{ providerCheckedAt: { sort: 'asc', nulls: 'first' } }],
      take: SWEEP_BATCH,
    });
    const byMerchant = new Map<string, ReconciliationResult>();
    for (const payment of due) {
      const result = byMerchant.get(payment.merchantId) ?? empty();
      byMerchant.set(payment.merchantId, result);
      await this.check(payment, result, now);
    }
    for (const [merchantId, result] of byMerchant) await this.record(merchantId, result);
  }

  /** Full check for one merchant (before each business report, or on demand). */
  async reconcile(merchantId: string, now = new Date()): Promise<ReconciliationResult> {
    const result = empty();
    if (this.paypal.configured) {
      const open = await this.db.payment.findMany({
        where: {
          merchantId,
          ...watched(now),
          createdAt: { lt: new Date(now.getTime() - MIN_AGE_MS) },
        },
        include: { order: { select: { reference: true, status: true } } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const payment of open) await this.check(payment, result, now);
    }
    result.mismatches.push(...(await this.mismatches(merchantId)));
    await this.record(merchantId, result);
    return result;
  }

  private async check(
    payment: Payment & { order: { reference: string; status: string } },
    result: ReconciliationResult,
    now: Date,
  ) {
    result.checked++;
    try {
      let status: string;
      try {
        status = (await this.paypal.getOrder(payment.externalId!)).status;
      } catch (error) {
        if (payPalErrorStatus(error) !== 404) throw error;
        status = 'NOT_FOUND';
      }
      await this.db.payment.update({
        where: { id: payment.id },
        data: { providerCheckedAt: now, providerStatus: status },
      });
      if (payment.status === 'CANCELLED') {
        // Never capture a cancelled link; only record money PayPal already captured.
        if (status === 'COMPLETED' && (await this.payments.recordLateCapture(payment)))
          result.recovered.push({
            reference: payment.order.reference,
            amount: formatMoney(payment.amountMinor, payment.currency),
          });
        return;
      }
      if (status === 'APPROVED' || status === 'COMPLETED') {
        const outcome = await this.payments.captureApproved(payment.externalId!);
        if (outcome === 'completed')
          result.recovered.push({
            reference: payment.order.reference,
            amount: formatMoney(payment.amountMinor, payment.currency),
          });
        else if (outcome === 'pending') result.pending.push(payment.order.reference);
      } else if (!PAYABLE.has(status)) {
        result.expired.push(payment.order.reference);
      }
    } catch (error) {
      result.errors++;
      this.logger.warn({ err: error, paymentId: payment.id }, 'reconciliation check failed');
    }
  }

  /** Orders and payments that disagree inside Katale. */
  private async mismatches(merchantId: string): Promise<string[]> {
    const [paidWithoutPayment, completedButUnpaid] = await Promise.all([
      this.db.order.findMany({
        where: { merchantId, status: 'PAID', payments: { none: { status: 'COMPLETED' } } },
        select: { reference: true },
        take: 20,
      }),
      this.db.payment.findMany({
        where: { merchantId, status: 'COMPLETED', order: { status: { not: 'PAID' } } },
        select: { order: { select: { reference: true, status: true } } },
        take: 20,
      }),
    ]);
    return [
      ...paidWithoutPayment.map(
        (o) => `${o.reference} is marked paid but has no completed PayPal payment`,
      ),
      ...completedButUnpaid.map(
        (p) =>
          `${p.order.reference} has a completed PayPal payment but the order is ${p.order.status.toLowerCase()}`,
      ),
    ];
  }

  private async record(merchantId: string, result: ReconciliationResult) {
    // Expired links are reported in the business report, not audited on every pass.
    if (!result.recovered.length && !result.mismatches.length) return;
    await this.audit.record({
      merchantId,
      actor: 'SYSTEM',
      type: 'payment.reconciled',
      entityType: 'merchant',
      entityId: merchantId,
      data: {
        checked: result.checked,
        recovered: result.recovered.map((r) => r.reference),
        expired: result.expired,
        mismatches: result.mismatches.length,
      },
    });
    if (result.mismatches.length)
      this.logger.error({ merchantId, mismatches: result.mismatches }, 'payment records disagree');
  }
}

const empty = (): ReconciliationResult => ({
  checked: 0,
  recovered: [],
  pending: [],
  expired: [],
  mismatches: [],
  errors: 0,
});
