import { formatMoney, type AuditService, type OrderService } from '@vca/commerce';
import type { Database, Merchant, Shipment } from '@vca/database';
import {
  normalizeCarrier,
  type CarrierChoice,
  type PayPalApi,
  type PayPalOrder,
} from '@vca/paypal';
import {
  ConflictError,
  PolicyViolationError,
  ProviderError,
  ValidationError,
  getCorrelationId,
  type Logger,
} from '@vca/shared';
import { z } from 'zod';

type OrderDetails = Awaited<ReturnType<OrderService['getByReference']>>;

/** What a SHIP confirmation is bound to (hashed with the confirmation). */
export const shipmentPayloadSchema = z.object({
  orderId: z.string(),
  orderReference: z.string(),
  paymentId: z.string(),
  paypalOrderId: z.string(),
  captureId: z.string(),
  carrier: z.string(),
  carrierNameOther: z.string().optional(),
  carrierLabel: z.string(),
  trackingNumber: z.string(),
});
export type ShipmentPayload = z.infer<typeof shipmentPayloadSchema>;

const TRACKING_NUMBER = /^[A-Za-z0-9-]{4,64}$/;

/** Tracking numbers are compared and sent without spaces ("1Z 999 AA1" → "1Z999AA1"). */
export const cleanTrackingNumber = (value: string) => value.replace(/[\s.]/g, '').toUpperCase();

export const carrierDisplay = (s: Pick<Shipment, 'carrier' | 'carrierNameOther'>) =>
  s.carrier === 'OTHER'
    ? (s.carrierNameOther ?? 'Other carrier')
    : normalizeCarrier(s.carrier).label;

/**
 * Fulfillment for paid orders: PayPal Orders v2 tracking. A shipment row exists only after
 * PayPal accepted the tracker, and only via a merchant's SHIP confirmation.
 */
export class ShipmentService {
  constructor(
    private readonly db: Database,
    private readonly paypal: PayPalApi,
    private readonly orders: OrderService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  list(merchantId: string, limit = 20) {
    return this.db.shipment.findMany({
      where: { merchantId },
      include: { order: { select: { reference: true, customer: { select: { name: true } } } } },
      orderBy: { shippedAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  /** Payment and fulfillment state of one order ("Where is ORD-1042?"). */
  async statusFor(merchantId: string, orderReference: string) {
    const order = await this.orders.getByReference(merchantId, orderReference);
    const shipments = await this.db.shipment.findMany({
      where: { orderId: order.id },
      orderBy: { shippedAt: 'desc' },
    });
    return { order, shipments };
  }

  /** The completed PayPal payment of a paid order, or why tracking can't be added yet. */
  private paidPayment(order: OrderDetails) {
    const payment = order.payments.find((p) => p.status === 'COMPLETED');
    if (order.status !== 'PAID' || !payment) {
      throw new PolicyViolationError(
        `${order.reference} is ${order.status === 'AWAITING_PAYMENT' ? 'still awaiting payment' : order.status.toLowerCase().replace(/_/g, ' ')}. Tracking can only be added after the PayPal payment is completed.`,
      );
    }
    if (order.attention === 'PAID_AFTER_CANCEL') {
      throw new PolicyViolationError(
        `${order.reference} was paid after it had been cancelled, so its stock may have been sold to someone else. Check stock and mark it reviewed in the dashboard (Orders) before adding tracking.`,
      );
    }
    if (!payment.captureId || !payment.externalId) {
      throw new ConflictError(`${order.reference} has no PayPal capture to attach tracking to.`);
    }
    return { ...payment, captureId: payment.captureId, externalId: payment.externalId };
  }

  /**
   * Validates a shipment request without changing anything, and returns the exact payload a
   * SHIP confirmation will be bound to.
   */
  async prepare(
    merchant: Pick<Merchant, 'id'>,
    input: { orderReference: string; carrier: string; trackingNumber: string },
  ): Promise<{
    payload: ShipmentPayload;
    order: OrderDetails;
    warnings: string[];
    /** The order's transaction trace (its payment's correlation ID). */
    traceId: string | null;
  }> {
    const order = await this.orders.getByReference(merchant.id, input.orderReference);
    const payment = this.paidPayment(order);
    const trackingNumber = cleanTrackingNumber(input.trackingNumber);
    if (!TRACKING_NUMBER.test(trackingNumber)) {
      throw new ValidationError(
        `'${input.trackingNumber}' doesn't look like a tracking number (4–64 letters, digits or dashes). Ask the merchant to check it.`,
      );
    }
    if (!input.carrier.trim()) throw new ValidationError('Which carrier shipped it?');
    const carrier: CarrierChoice = normalizeCarrier(input.carrier);

    const existing = await this.db.shipment.findMany({ where: { orderId: order.id } });
    if (existing.some((s) => s.trackingNumber === trackingNumber && s.status === 'SHIPPED')) {
      throw new ConflictError(
        `${order.reference} already has tracking ${trackingNumber}. Nothing to update.`,
      );
    }
    const warnings = existing
      .filter((s) => s.status === 'SHIPPED')
      .map(
        (s) =>
          `${order.reference} already has ${carrierDisplay(s)} tracking ${s.trackingNumber}; this adds a second tracking number.`,
      );
    return {
      order,
      warnings,
      traceId: payment.correlationId,
      payload: {
        orderId: order.id,
        orderReference: order.reference,
        paymentId: payment.id,
        paypalOrderId: payment.externalId,
        captureId: payment.captureId,
        carrier: carrier.carrier,
        ...(carrier.carrierNameOther ? { carrierNameOther: carrier.carrierNameOther } : {}),
        carrierLabel: carrier.label,
        trackingNumber,
      },
    };
  }

  /**
   * Executes a confirmed shipment: re-validates, sends the tracker to PayPal, verifies PayPal
   * holds it, then records it. Safe to repeat: PayPal is idempotent on capture + tracking
   * number, and the local row is unique per order + tracking number.
   */
  async addTracking(payload: ShipmentPayload, merchant: Pick<Merchant, 'id'>) {
    const order = await this.orders.getByReference(merchant.id, payload.orderId);
    const payment = this.paidPayment(order);
    if (payment.id !== payload.paymentId || payment.captureId !== payload.captureId) {
      throw new ConflictError(`${order.reference} changed since the shipment was proposed.`);
    }
    const already = await this.db.shipment.findUnique({
      where: {
        orderId_trackingNumber: { orderId: order.id, trackingNumber: payload.trackingNumber },
      },
    });
    if (already?.providerTrackerId && already.status === 'SHIPPED')
      return { shipment: already, order };

    const response = await this.paypal.addTracking({
      paypalOrderId: payload.paypalOrderId,
      captureId: payload.captureId,
      trackingNumber: payload.trackingNumber,
      carrier: payload.carrier,
      carrierNameOther: payload.carrierNameOther,
      notifyPayer: false,
    });
    const tracker =
      findTracker(response, payload.captureId, payload.trackingNumber) ??
      findTracker(
        await this.paypal.getOrder(payload.paypalOrderId),
        payload.captureId,
        payload.trackingNumber,
      );
    if (!tracker) {
      throw new ProviderError('paypal', 'PayPal did not confirm the tracker');
    }

    const shipment = await this.db.$transaction(async (tx) => {
      const row = await tx.shipment.upsert({
        where: {
          orderId_trackingNumber: { orderId: order.id, trackingNumber: payload.trackingNumber },
        },
        update: { status: 'SHIPPED', providerTrackerId: tracker.id, providerSyncedAt: new Date() },
        create: {
          merchantId: merchant.id,
          orderId: order.id,
          paymentId: payment.id,
          carrier: payload.carrier,
          carrierNameOther: payload.carrierNameOther ?? null,
          trackingNumber: payload.trackingNumber,
          providerTrackerId: tracker.id,
          providerSyncedAt: new Date(),
          correlationId: getCorrelationId() ?? null,
        },
      });
      await tx.order.update({ where: { id: order.id }, data: { fulfillmentStatus: 'SHIPPED' } });
      await this.audit.record(
        {
          merchantId: merchant.id,
          actor: 'PROVIDER',
          type: 'shipment.tracking_added',
          entityType: 'shipment',
          entityId: row.id,
          data: {
            orderReference: order.reference,
            carrier: payload.carrierLabel,
            trackingNumber: payload.trackingNumber,
            paypalTrackerId: tracker.id,
            paypalTrackerStatus: tracker.status ?? 'SHIPPED',
          },
        },
        tx,
      );
      return row;
    });
    this.logger.info({ orderReference: order.reference, trackerId: tracker.id }, 'tracking added');
    return { shipment, order };
  }

  /** Shipment summary lines for confirmations and replies. */
  static describe(payload: ShipmentPayload, order: OrderDetails) {
    return [
      `Order: ${payload.orderReference}`,
      `Customer: ${order.customer.name}`,
      `Amount: ${formatMoney(order.totalMinor, order.currency)}`,
      `Carrier: ${payload.carrierLabel}`,
      `Tracking: ${payload.trackingNumber}`,
    ];
  }
}

/** PayPal's tracker for this capture + tracking number (ID format `<captureId>-<trackingNumber>`). */
function findTracker(order: PayPalOrder, captureId: string, trackingNumber: string) {
  const trackers = (order.purchase_units ?? []).flatMap((u) => u.shipping?.trackers ?? []);
  return (
    trackers.find((t) => t.id === `${captureId}-${trackingNumber}`) ??
    trackers.find((t) => t.id.toUpperCase().endsWith(`-${trackingNumber}`))
  );
}
