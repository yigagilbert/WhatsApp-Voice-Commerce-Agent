import type { FastifyInstance } from 'fastify';
import { nextSlot } from '@vca/commerce';
import { ValidationError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';
import { DEFAULT_SCHEDULE } from '../reports/report-scheduler';

const idParams = z.object({ id: z.string().min(1).max(64) });
const adminBody = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(5).max(32),
  receiveReports: z.boolean().optional(),
  receiveAlerts: z.boolean().optional(),
  active: z.boolean().optional(),
  role: z.enum(['OWNER', 'STAFF']).optional(),
});
const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const scheduleBody = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  weekday: z.number().int().min(1).max(7),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: z.string().max(64).nullable(),
  includeSales: z.boolean(),
  includeInventory: z.boolean(),
  includeUnpaid: z.boolean(),
  includeDisputes: z.boolean(),
  includeChart: z.boolean(),
  includeInsights: z.boolean(),
});

/**
 * Admin WhatsApp numbers and proactive report settings (dashboard; every route is scoped to the
 * signed-in merchant by the dashboard-auth scope).
 */
export async function adminRoutes(app: FastifyInstance, { container }: { container: Container }) {
  const { admins, db } = container;

  const view = async (merchantId: string) => {
    const list = await admins.list(merchantId);
    const chats = await db.conversation.findMany({
      where: {
        merchantId,
        channel: 'whatsapp',
        externalChatId: { in: list.flatMap((a) => [a.externalId, a.whatsappLid ?? '']) },
      },
      select: { externalChatId: true, lastMessageAt: true },
    });
    const last = (a: (typeof list)[number]) =>
      chats
        .filter((c) => c.externalChatId === a.externalId || c.externalChatId === a.whatsappLid)
        .map((c) => c.lastMessageAt)
        .sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
    return list.map((a) => ({
      id: a.id,
      name: a.name,
      phone: a.phone,
      /** Registered before phone numbers were stored (WhatsApp ID only). */
      legacyId: a.phone ? null : a.externalId,
      linked: !!a.whatsappLid || a.externalId.endsWith('@lid'),
      active: a.active,
      receiveReports: a.receiveReports,
      receiveAlerts: a.receiveAlerts,
      role: a.role,
      lastMessageAt: last(a),
      createdAt: a.createdAt,
    }));
  };

  app.get('/api/admins', async (request) => view(request.merchant.id));

  app.post('/api/admins', async (request, reply) => {
    const body = parse(adminBody, request.body);
    const admin = await admins.create(request.merchant.id, body);
    return reply.status(201).send({ id: admin.id, phone: admin.phone });
  });

  app.patch('/api/admins/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(adminBody.partial(), request.body);
    const admin = await admins.update(request.merchant.id, id, body);
    return { id: admin.id, phone: admin.phone, active: admin.active, role: admin.role };
  });

  app.delete('/api/admins/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await admins.remove(request.merchant.id, id);
    return reply.status(204).send();
  });

  /** Sends a short test message so the owner can confirm the number works. */
  app.post('/api/admins/:id/test', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const admin = (await admins.list(request.merchant.id)).find((a) => a.id === id);
    if (!admin) return reply.status(404).send({ error: { message: 'Admin not found' } });
    if (!admin.active) throw new ValidationError('This admin is deactivated. Activate it first.');
    try {
      await container.notifications.sendToChat(
        request.merchant.id,
        admin.externalId,
        `*Katale AI*\n\n✅ Test message: this number is an admin for ${request.merchant.businessName}. You can message me to manage orders, payments and stock${admin.receiveReports ? ', and you will receive business reports' : ''}.`,
      );
      return { delivered: true };
    } catch (error) {
      return reply.status(502).send({
        error: {
          message: `Could not deliver: ${error instanceof Error ? error.message : 'WhatsApp unavailable'}`,
        },
      });
    }
  });

  // ─── Reports ───────────────────────────────────────────────────────────

  app.get('/api/reports/schedule', async (request) => {
    const saved = await db.reportSchedule.findUnique({
      where: { merchantId: request.merchant.id },
    });
    const schedule = { ...DEFAULT_SCHEDULE, ...(saved ?? {}) };
    const timeZone = schedule.timezone ?? request.merchant.timezone;
    return {
      ...schedule,
      merchantTimezone: request.merchant.timezone,
      nextAt: schedule.enabled
        ? nextSlot({ ...schedule, timeZone }, new Date()).toISOString()
        : null,
      recipients: (await admins.recipients(request.merchant.id, 'reports')).length,
    };
  });

  app.put('/api/reports/schedule', async (request) => {
    const body = parse(scheduleBody, request.body);
    if (body.timezone && !validTimeZone(body.timezone))
      throw new ValidationError(`Unknown time zone '${body.timezone}'.`);
    const saved = await db.reportSchedule.upsert({
      where: { merchantId: request.merchant.id },
      update: body,
      create: { merchantId: request.merchant.id, ...body },
    });
    await container.audit.record({
      merchantId: request.merchant.id,
      actor: 'MERCHANT',
      type: 'report.schedule_updated',
      entityType: 'report_schedule',
      entityId: saved.id,
      data: {
        enabled: body.enabled,
        frequency: body.frequency,
        weekday: body.weekday,
        time: `${body.hour}:${String(body.minute).padStart(2, '0')}`,
        timezone: body.timezone,
      },
    });
    return saved;
  });

  app.get('/api/reports/runs', async (request) =>
    db.reportRun.findMany({
      where: { merchantId: request.merchant.id },
      select: {
        id: true,
        periodKey: true,
        trigger: true,
        scheduledFor: true,
        status: true,
        text: true,
        createdAt: true,
        completedAt: true,
        deliveries: {
          select: {
            status: true,
            attempts: true,
            lastError: true,
            sentAt: true,
            operator: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  );

  app.post('/api/reports/send-now', async (request) => {
    const run = await container.reportScheduler.sendNow(request.merchant.id);
    return { status: run?.status ?? 'FAILED', deliveries: run?.deliveries.length ?? 0 };
  });
}
