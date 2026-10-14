import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';
import { carrierDisplay } from '../shipments/shipment.service';
import { reasonLabel, statusLabel } from './dispute.service';

/** Disputes for the dashboard (read-only; submissions go through SUBMIT confirmations). */
export async function disputesRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  app.get('/api/disputes', async (request) => {
    const { filter } = parse(
      z.object({ filter: z.enum(['open', 'needs_response', 'resolved', 'all']).default('all') }),
      request.query,
    );
    const { disputes, totals } = await container.disputes.list(request.merchant.id, filter);
    return {
      totals,
      disputes: disputes.map((d) => ({
        id: d.id,
        paypalDisputeId: d.paypalDisputeId,
        orderReference: d.order?.reference ?? null,
        customer: d.order?.customer.name ?? null,
        inputMode: d.order?.inputMode ?? null,
        reason: d.reason,
        reasonLabel: reasonLabel(d.reason),
        status: d.status,
        statusLabel: statusLabel(d.status),
        lifecycleStage: d.lifecycleStage,
        outcome: d.outcome,
        amountMinor: d.amountMinor,
        currency: d.currency,
        openedAt: d.openedAt,
        sellerResponseDueAt: d.sellerResponseDueAt,
        updatedAt: d.providerUpdatedAt ?? d.updatedAt,
      })),
    };
  });

  app.get('/api/disputes/:id', async (request) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(255) }), request.params);
    const d = await container.disputes.find(request.merchant.id, id);
    const evidence = container.disputes.evidenceFor(d, request.merchant.timezone);
    const timeline = await container.db.auditEvent.findMany({
      where: {
        merchantId: request.merchant.id,
        OR: [
          { entityType: 'dispute', entityId: d.id },
          ...(d.payment?.correlationId ? [{ correlationId: d.payment.correlationId }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return {
      id: d.id,
      paypalDisputeId: d.paypalDisputeId,
      reason: d.reason,
      reasonLabel: reasonLabel(d.reason),
      status: d.status,
      statusLabel: statusLabel(d.status),
      lifecycleStage: d.lifecycleStage,
      outcome: d.outcome,
      amountMinor: d.amountMinor,
      currency: d.currency,
      buyerMessage: d.buyerMessage,
      openedAt: d.openedAt,
      sellerResponseDueAt: d.sellerResponseDueAt,
      order: d.order
        ? {
            reference: d.order.reference,
            customer: d.order.customer.name,
            totalMinor: d.order.totalMinor,
            currency: d.order.currency,
            status: d.order.status,
            fulfillmentStatus: d.order.fulfillmentStatus,
          }
        : null,
      payment: d.payment
        ? {
            status: d.payment.status,
            amountMinor: d.payment.amountMinor,
            currency: d.payment.currency,
            captureId: d.payment.captureId,
            completedAt: d.payment.completedAt,
          }
        : null,
      shipments: (d.order?.shipments ?? []).map((s) => ({
        carrier: carrierDisplay(s),
        trackingNumber: s.trackingNumber,
        shippedAt: s.shippedAt,
        registeredWithPayPal: !!s.providerTrackerId,
      })),
      evidence,
      responses: d.responses.map((r) => ({
        id: r.id,
        status: r.status,
        responseText: r.responseText,
        evidence: r.evidence,
        submittedAt: r.submittedAt,
        createdAt: r.createdAt,
      })),
      timeline,
    };
  });

  /** Re-reads disputes from PayPal (reconciliation; webhooks are the primary path). */
  app.post('/api/disputes/refresh', async () => ({ synced: await container.disputes.refresh() }));
}
