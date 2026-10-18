import type { Database } from '@vca/database';
import { HEADERS, type Logger } from '@vca/shared';
import type { NotificationService } from '../notifications/notification.service';

/** Outages shorter than this (e.g. a deploy restart) are not reported. */
const ALERT_AFTER_MS = 5 * 60_000;
const TICK_MS = 60_000;

export interface ConnectionHealth {
  /** Worker state ("ready", "qr", "disconnected", …) or "unreachable". */
  state: string;
  /** When the bot stopped being ready (null while connected). */
  downSince: string | null;
  checkedAt: string | null;
}

/**
 * Watches the WhatsApp worker from the API (one GET per minute). While the bot is down its
 * own alerts can't be sent, so admins are told once it is back: when it went down, for how
 * long, and that messages sent meanwhile may be missing. The latest state is cached for the
 * dashboard banner (no worker call per page view).
 */
export class WhatsAppConnectionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private health: ConnectionHealth = { state: 'unknown', downSince: null, checkedAt: null };

  constructor(
    private readonly db: Database,
    private readonly notifications: NotificationService,
    private readonly gatewayUrl: string | undefined,
    private readonly internalToken: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get current(): ConnectionHealth {
    return this.health;
  }

  start() {
    if (this.timer || !this.gatewayUrl) return;
    this.timer = setInterval(() => void this.check(), TICK_MS);
    this.timer.unref();
    void this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchState(): Promise<string> {
    try {
      const res = await this.fetchImpl(`${this.gatewayUrl!.replace(/\/$/, '')}/internal/session`, {
        headers: { [HEADERS.internalToken]: this.internalToken },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return 'unreachable';
      return ((await res.json()) as { state?: string }).state ?? 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  /** One check. Exposed for tests. */
  async check(now = new Date()): Promise<void> {
    if (!this.gatewayUrl) return;
    const state = await this.fetchState();
    const previous = this.health;
    if (state === 'ready') {
      const downSince = previous.downSince ? new Date(previous.downSince) : null;
      this.health = { state, downSince: null, checkedAt: now.toISOString() };
      if (downSince && now.getTime() - downSince.getTime() >= ALERT_AFTER_MS)
        await this.reportOutage(downSince, now).catch((error: unknown) =>
          this.logger.error({ err: error }, 'outage notice failed'),
        );
      return;
    }
    // A first check that isn't ready (e.g. right after an API restart) starts the clock now.
    this.health = {
      state,
      downSince: previous.downSince ?? now.toISOString(),
      checkedAt: now.toISOString(),
    };
    if (!previous.downSince) this.logger.warn({ state }, 'WhatsApp bot is not connected');
  }

  private async reportOutage(from: Date, to: Date) {
    const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
    const duration =
      minutes >= 120
        ? `${Math.round(minutes / 60)} hours`
        : `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const merchants = await this.db.merchant.findMany({ select: { id: true, timezone: true } });
    for (const merchant of merchants) {
      const time = (d: Date) =>
        new Intl.DateTimeFormat('en-GB', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: merchant.timezone,
        }).format(d);
      const sent = await this.notifications.toAdmins(
        merchant.id,
        `*Katale AI*\n\n⚠️ WhatsApp was disconnected for ${duration} (${time(from)} – ${time(to)}). It's working again. Messages sent to me during that time may not have arrived, so please resend anything important.`,
      );
      if (sent)
        await this.db.auditEvent.create({
          data: {
            merchantId: merchant.id,
            actor: 'SYSTEM',
            type: 'whatsapp.outage',
            data: { from: from.toISOString(), to: to.toISOString(), minutes },
          },
        });
    }
    this.logger.warn({ minutes }, 'WhatsApp outage reported to admins');
  }
}
