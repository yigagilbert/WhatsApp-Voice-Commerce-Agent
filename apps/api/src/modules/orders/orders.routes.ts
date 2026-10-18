import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

const listQuery = z.object({
  status: z.enum(['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Orders and payments (dashboard). Read-only, except payment reminders: the dashboard button is
 * the merchant's explicit approval, and the reminder service re-checks everything (incl. PayPal).
 */
export async function ordersRoutes(app: FastifyInstance, { container }: { container: Container }) {
  app.get('/api/orders', async (request) => {
    const query = parse(listQuery, request.query);
    return container.orders.list(request.merchant.id, query);
  });

  app.get('/api/orders/:reference', async (request) => {
    const { reference } = parse(z.object({ reference: z.string().min(1).max(64) }), request.params);
    return container.orders.getByReference(request.merchant.id, reference);
  });

  app.get('/api/payments', async (request) => {
    const { limit } = parse(listQuery.pick({ limit: true }), request.query);
    return container.payments.list(request.merchant.id, { ...(limit ? { limit } : {}) });
  });

  app.post('/api/payments/:id/remind', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), request.params);
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
