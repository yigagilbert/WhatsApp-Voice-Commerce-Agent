import type { Logger } from '@vca/shared';

export interface OpsAlertsOptions {
  /** POST target for alerts (an ntfy.sh topic URL, or any webhook accepting a plain-text body). */
  webhookUrl?: string | undefined;
  /** Dead-man's switch pinged after healthy scheduler passes (healthchecks.io-style URL). */
  heartbeatUrl?: string | undefined;
  logger: Logger;
  fetch?: typeof fetch;
  /** The same alert key is sent at most once per this window (default 30 minutes). */
  repeatAfterMs?: number;
}

const HEARTBEAT_EVERY_MS = 5 * 60_000;

/**
 * Operator alerts that don't depend on WhatsApp (which may be the thing that is down): a webhook
 * such as an ntfy topic pushes them to the operator's phone. Best effort: alerting never throws
 * and never blocks business logic. Messages carry no customer data or secrets, only what broke.
 */
export class OpsAlerts {
  private readonly lastSent = new Map<string, number>();
  private lastHeartbeat = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpsAlertsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured() {
    return !!this.options.webhookUrl;
  }

  /**
   * Sends `message` unless the same `key` was alerted recently. Returns whether it was sent.
   * `title` becomes the notification title (ntfy shows it; other webhooks see it in the body).
   */
  async alert(key: string, title: string, message: string, now = Date.now()): Promise<boolean> {
    this.options.logger.error({ alert: key }, `ops alert: ${title}`);
    if (!this.options.webhookUrl) return false;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < (this.options.repeatAfterMs ?? 30 * 60_000))
      return false;
    this.lastSent.set(key, now);
    try {
      const res = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          // ntfy notification metadata; ignored by other webhooks.
          Title: `Katale AI: ${title}`.replace(/[^\x20-\x7E]/g, ''),
          Priority: 'high',
          Tags: 'warning',
        },
        body: `${title}\n\n${message}`,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.options.logger.warn({ status: res.status }, 'ops alert delivery failed');
      return res.ok;
    } catch (error) {
      this.options.logger.warn({ err: error }, 'ops alert delivery failed');
      return false;
    }
  }

  /** "All clear" for a key that alerted before (so the operator knows it recovered). */
  async resolve(key: string, title: string, message: string): Promise<void> {
    if (!this.lastSent.has(key)) return;
    this.lastSent.delete(key);
    await this.alert(`${key}:resolved`, title, message);
    this.lastSent.delete(`${key}:resolved`);
  }

  /** Pings the heartbeat URL at most every 5 minutes. A missed ping = API down or scheduler stuck. */
  async heartbeat(now = Date.now()): Promise<void> {
    if (!this.options.heartbeatUrl || now - this.lastHeartbeat < HEARTBEAT_EVERY_MS) return;
    this.lastHeartbeat = now;
    try {
      await this.fetchImpl(this.options.heartbeatUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.options.logger.warn({ err: error }, 'heartbeat ping failed');
    }
  }
}
