import { latestSlot, type AdminService, type AuditService } from '@vca/commerce';
import type { Database, ReportRun, ReportSchedule } from '@vca/database';
import type { Logger } from '@vca/shared';
import type { NotificationService } from '../notifications/notification.service';
import type { PaymentReconciler } from '../payments/reconciliation.service';
import type { BusinessReportBuilder } from './business-report';
import type { OpsAlerts } from '../ops/ops-alerts';

/** Retries after a failed delivery: 2, 5, 15 minutes; then the delivery stays FAILED. */
const BACKOFF_MINUTES = [2, 5, 15];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A scheduled slot is still sent if the API was down when it fell due, for this long. */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 60_000;

/** Background work run once per scheduler tick, after reports and payment checks. */
export interface ScheduledJob {
  name: string;
  run(now: Date): Promise<void>;
}

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

export const DEFAULT_SCHEDULE = {
  enabled: false,
  frequency: 'WEEKLY' as const,
  weekday: 1,
  hour: 8,
  minute: 0,
  timezone: null,
  includeSales: true,
  includeInventory: true,
  includeUnpaid: true,
  includeDisputes: true,
  includeChart: true,
  includeInsights: true,
};

/**
 * Proactive business reports. A one-minute in-process tick (no extra infrastructure) that:
 *  1. creates a run for each enabled schedule whose slot is due — (merchant, periodKey) is unique,
 *     so restarts, overlapping ticks or a second instance never send a slot twice;
 *  2. delivers each run to every active admin who opted in, tracking text and chart separately and
 *     retrying failures (e.g. WhatsApp disconnected) with backoff.
 */
export class ReportScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly builder: BusinessReportBuilder,
    private readonly admins: AdminService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    /** Re-checks open PayPal links in the background on the same tick (optional). */
    private readonly reconciler?: PaymentReconciler,
    /** Other background work that runs on the same tick (e.g. unpaid-order expiry). */
    private readonly jobs: ScheduledJob[] = [],
    /** Operator alerts for failed jobs/reports, and the heartbeat after healthy passes. */
    private readonly alerts?: Pick<OpsAlerts, 'alert' | 'heartbeat'>,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler pass. Safe to call concurrently (skips while another pass runs). */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const schedules = await this.db.reportSchedule.findMany({
        where: { enabled: true },
        include: { merchant: true },
      });
      for (const schedule of schedules) {
        const tz = schedule.timezone ?? schedule.merchant.timezone;
        const slot = latestSlot({ ...schedule, timeZone: tz }, now);
        if (now.getTime() - slot.at.getTime() > CATCH_UP_MS) continue;
        await this.createRun(schedule.merchantId, schedule, {
          periodKey: slot.periodKey,
          trigger: 'SCHEDULED',
          scheduledFor: slot.at,
          now,
        }).catch((error: unknown) =>
          this.logger.error({ err: error, merchantId: schedule.merchantId }, 'report run failed'),
        );
      }
      await this.deliverDue(now);
      await this.reconciler
        ?.sweep(now)
        .catch((error: unknown) => this.logger.error({ err: error }, 'payment sweep failed'));
      let healthy = true;
      for (const job of this.jobs) {
        await job.run(now).catch(async (error: unknown) => {
          healthy = false;
          this.logger.error({ err: error, job: job.name }, 'scheduled job failed');
          await this.alerts?.alert(
            `job-${job.name}`,
            `Background job failed: ${job.name}`,
            `${error instanceof Error ? error.message.slice(0, 300) : String(error)}\nIt runs again every minute; check the API logs if this repeats.`,
          );
        });
      }
      // Dead-man's switch: only healthy passes ping, so a stuck or failing scheduler goes quiet.
      if (healthy) await this.alerts?.heartbeat(now.getTime());
    } catch (error) {
      this.logger.error({ err: error }, 'report scheduler tick failed');
      await this.alerts?.alert(
        'scheduler-tick',
        'Background scheduler failed',
        `${error instanceof Error ? error.message.slice(0, 300) : String(error)}\nReports, payment checks and order expiry may be delayed.`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Builds and sends a report now (dashboard "Send now"). */
  async sendNow(merchantId: string, now = new Date()) {
    const schedule = await this.db.reportSchedule.findUnique({ where: { merchantId } });
    const run = await this.createRun(merchantId, schedule, {
      periodKey: `MANUAL:${now.toISOString()}`,
      trigger: 'MANUAL',
      scheduledFor: now,
      now,
    });
    await this.deliverDue(now, run?.id);
    return run
      ? this.db.reportRun.findUnique({ where: { id: run.id }, include: { deliveries: true } })
      : null;
  }

  /** Creates the run (once per period key) and one delivery per eligible admin. */
  private async createRun(
    merchantId: string,
    schedule: Partial<ReportSchedule> | null,
    run: { periodKey: string; trigger: string; scheduledFor: Date; now: Date },
  ): Promise<ReportRun | null> {
    if (
      await this.db.reportRun.findUnique({
        where: { merchantId_periodKey: { merchantId, periodKey: run.periodKey } },
      })
    )
      return null;
    const merchant = await this.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const s = { ...DEFAULT_SCHEDULE, ...(schedule ?? {}) };
    const report = await this.builder.build(
      merchant,
      {
        title: `${s.frequency === 'DAILY' ? 'Daily' : s.frequency === 'MONTHLY' ? 'Monthly' : 'Weekly'} business report`,
        sections: s,
        timeZone: s.timezone,
        monthly: s.frequency === 'MONTHLY',
      },
      run.now,
    );
    let created: ReportRun;
    try {
      created = await this.db.reportRun.create({
        data: {
          merchantId,
          periodKey: run.periodKey,
          trigger: run.trigger,
          scheduledFor: run.scheduledFor,
          text: report.text,
          chartBase64: report.chart?.media.dataBase64 ?? null,
          chartCaption: report.chart?.caption ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null; // another tick/instance got there first
      throw error;
    }
    const recipients = await this.admins.recipients(merchantId, 'reports');
    await this.db.reportDelivery.createMany({
      data: recipients.map((admin) => ({
        runId: created.id,
        operatorId: admin.id,
        chatId: admin.externalId,
        nextAttemptAt: run.now,
      })),
      skipDuplicates: true,
    });
    await this.audit.record({
      merchantId,
      actor: 'SYSTEM',
      type: 'report.generated',
      entityType: 'report',
      entityId: created.id,
      data: {
        periodKey: run.periodKey,
        trigger: run.trigger,
        recipients: recipients.length,
        facts: report.facts,
      },
    });
    if (!recipients.length) {
      this.logger.warn({ merchantId }, 'report generated but no active admin opted in to reports');
      return this.db.reportRun.update({
        where: { id: created.id },
        data: { status: 'FAILED', completedAt: new Date() },
      });
    }
    return created;
  }

  /** Attempts every delivery that is due (new or awaiting retry). */
  private async deliverDue(now: Date, runId?: string) {
    const due = await this.db.reportDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        attempts: { lt: MAX_ATTEMPTS },
        nextAttemptAt: { lte: now },
        ...(runId ? { runId } : {}),
      },
      include: { run: true, operator: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const touched = new Set<string>();
    for (const delivery of due) {
      touched.add(delivery.runId);
      await this.attempt(delivery, now);
    }
    for (const id of touched) await this.settleRun(id);
  }

  private async attempt(
    delivery: Awaited<ReturnType<Database['reportDelivery']['findMany']>>[number] & {
      run: ReportRun;
      operator: { active: boolean; receiveReports: boolean; externalId: string };
    },
    now: Date,
  ) {
    const { run, operator } = delivery;
    if (!operator.active || !operator.receiveReports) {
      // Turned off since the run was created: never send, never retry.
      await this.db.reportDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          attempts: MAX_ATTEMPTS,
          lastError: 'admin no longer receives reports',
        },
      });
      return;
    }
    try {
      if (!delivery.textSentAt) {
        await this.notifications.sendToChat(run.merchantId, delivery.chatId, run.text);
        await this.db.reportDelivery.update({
          where: { id: delivery.id },
          data: { textSentAt: new Date() },
        });
      }
      if (run.chartBase64 && !delivery.chartSentAt) {
        await this.notifications.sendToChat(
          run.merchantId,
          delivery.chatId,
          run.chartCaption ?? 'Revenue, last 7 days',
          {
            mimeType: 'image/png',
            dataBase64: run.chartBase64,
            filename: 'revenue.png',
          },
        );
        await this.db.reportDelivery.update({
          where: { id: delivery.id },
          data: { chartSentAt: new Date() },
        });
      }
      await this.db.reportDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, deliveryId: delivery.id, attempts }, 'report delivery failed');
      await this.db.reportDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          attempts,
          lastError: message.slice(0, 300),
          nextAttemptAt: new Date(now.getTime() + wait * 60_000),
        },
      });
    }
  }

  /** SENT when every admin got it; PARTIAL/FAILED once nothing is left to retry. */
  private async settleRun(runId: string) {
    const deliveries = await this.db.reportDelivery.findMany({ where: { runId } });
    const sent = deliveries.filter((d) => d.status === 'SENT').length;
    const retrying = deliveries.some((d) => d.status !== 'SENT' && d.attempts < MAX_ATTEMPTS);
    const status =
      sent === deliveries.length ? 'SENT' : retrying ? 'SENDING' : sent ? 'PARTIAL' : 'FAILED';
    const run = await this.db.reportRun.update({
      where: { id: runId },
      data: { status, ...(status === 'SENDING' ? {} : { completedAt: new Date() }) },
    });
    if (status === 'FAILED' || status === 'PARTIAL')
      await this.alerts?.alert(
        `report-${run.merchantId}`,
        status === 'FAILED' ? 'Business report not delivered' : 'Business report partly delivered',
        `Report ${run.periodKey}: delivered to ${sent} of ${deliveries.length} admins after all retries. Is WhatsApp connected?`,
      );
    if (status !== 'SENDING') {
      await this.audit.record({
        merchantId: run.merchantId,
        actor: 'SYSTEM',
        type: `report.${status.toLowerCase()}`,
        entityType: 'report',
        entityId: run.id,
        data: { periodKey: run.periodKey, delivered: sent, recipients: deliveries.length },
      });
    }
  }
}
