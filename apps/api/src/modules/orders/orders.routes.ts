import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

const listQuery = z.object({
  status: z.enum(['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Orders and payments (dashboard, read-only — financial writes go through confirmations). */
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
}
