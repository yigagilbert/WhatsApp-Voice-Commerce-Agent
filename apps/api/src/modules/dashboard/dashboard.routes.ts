import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

export async function dashboardRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  app.get('/api/dashboard/summary', async (request) => ({
    merchant: {
      id: request.merchant.id,
      businessName: request.merchant.businessName,
      preferredCurrency: request.merchant.preferredCurrency,
      timezone: request.merchant.timezone,
    },
    ...(await container.analytics.dashboardSummary(request.merchant)),
  }));

  /** Flat tables for the AG Studio analytics workspace. */
  app.get('/api/dashboard/dataset', async (request) =>
    container.analytics.dataset(request.merchant),
  );

  /** Audit trail: AI decisions, confirmations, payments — the "responsible AI" activity log. */
  app.get('/api/dashboard/activity', async (request) => {
    const { limit, correlationId } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        correlationId: z.string().min(8).max(128).optional(),
      }),
      request.query,
    );
    return container.audit.list(request.merchant.id, limit, correlationId);
  });

  /** Recent conversation messages across channels (transcripts included). */
  app.get('/api/dashboard/messages', async (request) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      request.query,
    );
    return container.db.message.findMany({
      where: { conversation: { merchantId: request.merchant.id } },
      include: { conversation: { select: { channel: true, externalChatId: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  });
}
