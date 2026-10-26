import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

const listQuery = z.object({
  status: z.enum(['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const referenceParams = z.object({ reference: z.string().min(1).max(64) });
const idParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Orders and payments (dashboard). Merchant actions: payment reminders, cancelling unpaid orders
 * and refreshing a payment's status/refunds from PayPal. Each button is the merchant's explicit
 * approval; the services re-check everything (incl. PayPal) before acting.
 */
export async function ordersRoutes(app: FastifyInstance, { container }: { container: Container }) {
  app.get('/api/orders', async (request) => {
    const query = parse(listQuery, request.query);
    return container.orders.list(request.merchant.id, query);
  });

  app.get('/api/orders/:reference', async (request) => {
    const { reference } = parse(referenceParams, request.params);
    return container.orders.getByReference(request.merchant.id, reference);
  });

  /** Cancels an unpaid order (never a paid one); PayPal is checked first. Idempotent. */
  app.post('/api/orders/:reference/cancel', async (request, reply) => {
    const { reference } = parse(referenceParams, request.params);
    const outcome = await container.orderLifecycle.cancel({
      merchantId: request.merchant.id,
      reference,
      by: 'MERCHANT',
      actorLabel: 'dashboard',
    });
    if (!outcome) return reply.status(404).send({ error: { message: 'Order not found' } });
    if (outcome.status === 'not_cancellable')
      return reply.status(409).send({ error: { message: outcome.reason } });
    return { status: outcome.status, reference: outcome.order.reference };
  });

  /**
   * Payment review: re-reads the payment from PayPal (completes a payment whose webhook was
   * missed, records refunds) and returns its current state. Read-mostly, idempotent.
   */
  app.post('/api/payments/:id/refresh', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const payment = await container.db.payment.findFirst({
      where: { id, merchantId: request.merchant.id },
    });
    if (!payment) return reply.status(404).send({ error: { message: 'Payment not found' } });
    if (payment.externalId && (payment.status === 'CREATED' || payment.status === 'APPROVED')) {
      const paypalOrder = await container.paypal.getOrder(payment.externalId);
      if (paypalOrder.status === 'APPROVED' || paypalOrder.status === 'COMPLETED')
        await container.payments.captureApproved(payment.externalId);
    }
    const current = await container.db.payment.findUniqueOrThrow({ where: { id } });
    if (current.status === 'COMPLETED' || current.status === 'REFUNDED')
      await container.refunds.sync(current);
    const result = await container.db.payment.findUniqueOrThrow({
      where: { id },
      include: { refunds: { orderBy: { createdAt: 'asc' } } },
    });
    return result;
  });

  app.get('/api/payments', async (request) => {
    const { limit } = parse(listQuery.pick({ limit: true }), request.query);
    return container.payments.list(request.merchant.id, { ...(limit ? { limit } : {}) });
  });

  app.post('/api/payments/:id/remind', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const payment = await container.db.payment.findFirst({
      where: { id, merchantId: request.merchant.id },
      select: { id: true, order: { select: { reference: true } } },
    });
    if (!payment) return reply.status(404).send({ error: { message: 'Payment not found' } });
    const { payload } = await container.reminders.prepare(
      request.merchant,
      payment.order.reference,
    );
    if (payload.paymentId !== payment.id) {
      return reply
        .status(409)
        .send({ error: { message: 'This is not the open payment link for the order.' } });
    }
    const outcome = await container.reminders.send(request.merchant, payload, 'dashboard');
    return { ...outcome, customer: payload.customerName, orderReference: payload.orderReference };
  });
}
