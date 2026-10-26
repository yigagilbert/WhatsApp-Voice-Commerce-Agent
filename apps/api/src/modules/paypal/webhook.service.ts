import type { Database, Payment, Prisma } from '@vca/database';
import {
  payPalErrorStatus,
  extractCaptureRefs,
  extractDisputeId,
  extractOrderRefs,
  extractRefundRefs,
  readWebhookHeaders,
  webhookEnvelopeSchema,
  type PayPalApi,
  type WebhookEnvelope,
} from '@vca/paypal';
import { UnauthorizedError, ValidationError, type Logger } from '@vca/shared';
import type { PaymentService } from '../payments/payment.service';
import type { DisputeService } from '../disputes/dispute.service';
import type { RefundService } from '../payments/refund.service';

export interface WebhookServiceOptions {
  webhookId: string | undefined;
  /** Only honoured when NODE_ENV=development. */
  skipVerification: boolean;
}

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate';

/** An event left RECEIVED this long (e.g. the process died mid-dispatch) may be claimed again. */
const STALE_CLAIM_MS = 5 * 60_000;

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/**
 * PayPal webhook pipeline: verify signature → record event once (provider + event ID) →
 * dispatch → mark processed. Redelivered events are acknowledged without side effects;
 * events that previously FAILED are retried.
 */
export class PayPalWebhookService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly payments: PaymentService,
    private readonly disputes: DisputeService,
    private readonly logger: Logger,
    private readonly options: WebhookServiceOptions,
    private readonly refunds?: RefundService,
  ) {}

  async handle(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookOutcome> {
    await this.verify(rawBody, headers);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('Webhook body is not valid JSON');
    }
    const parsed = webhookEnvelopeSchema.safeParse(json);
    if (!parsed.success) throw new ValidationError('Unrecognised webhook payload');
    const event = parsed.data;

    const record = await this.claim(event);
    if (!record) return 'duplicate';

    try {
      const outcome = await this.dispatch(event);
      await this.db.webhookEvent.update({
        where: { id: record.id },
        data: {
          status: outcome === 'ignored' ? 'IGNORED' : 'PROCESSED',
          processedAt: new Date(),
          error: null,
        },
      });
      return outcome;
    } catch (error) {
      await this.db.webhookEvent.update({
        where: { id: record.id },
        data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) },
      });
      throw error; // non-2xx → PayPal redelivers later
    }
  }

  private async verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (this.options.skipVerification) {
      this.logger.warn('PayPal webhook signature verification is DISABLED (development only)');
      return;
    }
    const signatureHeaders = readWebhookHeaders(headers);
    if (!signatureHeaders) throw new UnauthorizedError('Missing PayPal signature headers');
    if (!this.options.webhookId) throw new UnauthorizedError('PAYPAL_WEBHOOK_ID is not configured');
    let valid: boolean;
    try {
      valid = await this.paypal.verifyWebhookSignature({
        headers: signatureHeaders,
        rawBody,
        webhookId: this.options.webhookId,
      });
    } catch (error) {
      // PayPal rejects malformed verification input (forged headers/body) with 4xx: treat as
      // an invalid signature. 5xx/network errors propagate so genuine events are redelivered.
      const status = payPalErrorStatus(error);
      if (status !== undefined && status >= 400 && status < 500) valid = false;
      else throw error;
    }
    if (!valid) throw new UnauthorizedError('Invalid PayPal webhook signature');
  }

  /**
   * Inserts the event row; returns null if it was already handled successfully or is being
   * handled right now. FAILED events, and RECEIVED events whose handler never finished, are
   * claimed again.
   */
  private async claim(event: WebhookEnvelope) {
    try {
      return await this.db.webhookEvent.create({
        data: {
          provider: 'PAYPAL',
          eventId: event.id,
          eventType: event.event_type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.webhookEvent.findUnique({
        where: { provider_eventId: { provider: 'PAYPAL', eventId: event.id } },
      });
      if (!existing || existing.status === 'PROCESSED' || existing.status === 'IGNORED')
        return null;
      // Previously failed or abandoned: claim it for a retry (the conditional update means only
      // one redelivery wins; updatedAt marks the new claim).
      const { count } = await this.db.webhookEvent.updateMany({
        where: {
          id: existing.id,
          OR: [
            { status: 'FAILED' },
            { status: 'RECEIVED', claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
          ],
        },
        data: { status: 'RECEIVED', error: null, claimedAt: new Date() },
      });
      return count === 1 ? existing : null;
    }
  }

  private async dispatch(event: WebhookEnvelope): Promise<'processed' | 'ignored'> {
    this.logger.info({ eventId: event.id, eventType: event.event_type }, 'paypal webhook');
    const audit = async (payment: Payment | null) => {
      if (payment) await this.payments.recordWebhook(payment, event);
    };

    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const refs = extractOrderRefs(event.resource);
        if (!refs) return 'ignored';
        await audit(await this.payments.findByProviderRefs({ paypalOrderId: refs.paypalOrderId }));
        const outcome = await this.payments.captureApproved(refs.paypalOrderId);
        return outcome === 'unknown_order' ? 'ignored' : 'processed';
      }
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const refs = extractCaptureRefs(event.resource);
        const payment = refs && (await this.payments.findByProviderRefs(refs));
        if (!payment) return 'ignored';
        await audit(payment);
        await this.payments.inTransactionTrace(payment, () =>
          this.payments.markCompleted(payment.id, refs.captureId, refs.amount),
        );
        return 'processed';
      }
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const refs = extractCaptureRefs(event.resource);
        const payment = refs && (await this.payments.findByProviderRefs(refs));
        if (!payment) return 'ignored';
        await audit(payment);
        await this.payments.inTransactionTrace(payment, () =>
          this.payments.applyStatus(payment, 'FAILED'),
        );
        return 'processed';
      }
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        // The resource only identifies the payment; refunds are re-read from PayPal.
        const refs = extractRefundRefs(event.resource);
        if (!refs) return 'ignored';
        const payment =
          (refs.captureId && (await this.payments.findByCaptureId(refs.captureId))) ||
          (await this.payments.findByCaptureId(refs.resourceId)) ||
          (await this.payments.findByProviderRefs(refs));
        if (!payment) return 'ignored';
        await audit(payment);
        await this.payments.inTransactionTrace(payment, async () => {
          if (this.refunds) await this.refunds.sync(payment);
          else await this.payments.applyStatus(payment, 'REFUNDED');
        });
        return 'processed';
      }
      case 'CUSTOMER.DISPUTE.CREATED':
      case 'CUSTOMER.DISPUTE.UPDATED':
      case 'CUSTOMER.DISPUTE.RESOLVED': {
        // The payload is only a trigger: the dispute is re-read from PayPal before anything is stored.
        const disputeId = extractDisputeId(event.resource);
        if (!disputeId) return 'ignored';
        const receivedAt = new Date();
        const dispute = await this.disputes.sync(disputeId);
        await this.disputes.recordWebhook(dispute, event, receivedAt);
        return 'processed';
      }
      default:
        return 'ignored';
    }
  }
}
