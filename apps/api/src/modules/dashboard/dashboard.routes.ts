import type { Prisma } from '@vca/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

const MAX_LAYOUT_BYTES = 512 * 1024;

/** An AG Studio report state. Studio validates the contents when it loads one. */
const layoutSchema = z.object({
  state: z.looseObject({
    pages: z
      .array(z.looseObject({ id: z.string() }))
      .min(1)
      .max(20),
  }),
});

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

  /** The signed-in person's saved Overview layout (null = use the default). */
  app.get('/api/dashboard/layout', async (request) => {
    const saved = await container.db.dashboardLayout.findUnique({
      where: {
        merchantId_userKey: { merchantId: request.merchant.id, userKey: request.dashboardUser.id },
      },
    });
    return { state: saved?.state ?? null, updatedAt: saved?.updatedAt ?? null };
  });

  app.put('/api/dashboard/layout', { bodyLimit: MAX_LAYOUT_BYTES }, async (request) => {
    const { state } = parse(layoutSchema, request.body);
    const key = { merchantId: request.merchant.id, userKey: request.dashboardUser.id };
    const saved = await container.db.dashboardLayout.upsert({
      where: { merchantId_userKey: key },
      create: { ...key, state: state as Prisma.InputJsonValue },
      update: { state: state as Prisma.InputJsonValue },
    });
    return { updatedAt: saved.updatedAt };
  });

  app.delete('/api/dashboard/layout', async (request) => {
    await container.db.dashboardLayout.deleteMany({
      where: { merchantId: request.merchant.id, userKey: request.dashboardUser.id },
    });
    return { state: null };
  });

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
