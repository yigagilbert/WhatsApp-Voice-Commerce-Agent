import { describe, expect, it } from 'vitest';
import { createLogger } from '@vca/shared';
import type { Database } from '@vca/database';
import type { NotificationService } from '../notifications/notification.service';
import { WhatsAppConnectionMonitor } from './connection-monitor';

const MIN = 60_000;

function setup() {
  let state: string | null = 'ready';
  const sent: { merchantId: string; text: string }[] = [];
  const audits: unknown[] = [];
  const db = {
    merchant: { findMany: async () => [{ id: 'm1', timezone: 'Africa/Kampala' }] },
    auditEvent: { create: async (a: unknown) => audits.push(a) },
  } as unknown as Database;
  const notifications = {
    toAdmins: async (merchantId: string, text: string) => (sent.push({ merchantId, text }), 1),
  } as unknown as NotificationService;
  const fetchImpl = (async () =>
    state === null
      ? Promise.reject(new Error('ECONNREFUSED'))
      : new Response(JSON.stringify({ state }), { status: 200 })) as typeof fetch;
  const alerts: string[] = [];
  const opsAlerts = {
    alert: async (key: string) => (alerts.push(key), true),
    resolve: async (key: string) => void alerts.push(`${key}:resolved`),
  };
  const monitor = new WhatsAppConnectionMonitor(
    db,
    notifications,
    'http://worker:4100',
    'token',
    createLogger({ name: 't', level: 'silent' }),
    fetchImpl,
    opsAlerts,
  );
  return { monitor, sent, audits, alerts, set: (s: string | null) => (state = s) };
}

describe('WhatsApp connection monitor', () => {
  it('reports an outage to admins once the bot is back', async () => {
    const { monitor, sent, audits, set } = setup();
    const t0 = new Date('2026-10-18T09:00:00Z');
    await monitor.check(t0);
    expect(monitor.current).toMatchObject({ state: 'ready', downSince: null });

    set('disconnected');
    await monitor.check(new Date(t0.getTime() + MIN));
    set(null); // worker restarting
    await monitor.check(new Date(t0.getTime() + 5 * MIN));
    expect(monitor.current).toMatchObject({
      state: 'unreachable',
      downSince: new Date(t0.getTime() + MIN).toISOString(),
    });
    expect(sent).toHaveLength(0); // can't message while down

    set('ready');
    await monitor.check(new Date(t0.getTime() + 21 * MIN));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(
      'WhatsApp was disconnected for 20 minutes (18 Oct, 12:01 – 18 Oct, 12:21)',
    );
    expect(audits).toHaveLength(1);
    expect(monitor.current.downSince).toBeNull();

    // Still connected: nothing more.
    await monitor.check(new Date(t0.getTime() + 22 * MIN));
    expect(sent).toHaveLength(1);
  });

  it('ignores short blips such as a deploy restart', async () => {
    const { monitor, sent, set } = setup();
    const t0 = new Date('2026-10-18T09:00:00Z');
    set('starting');
    await monitor.check(t0);
    set('ready');
    await monitor.check(new Date(t0.getTime() + 2 * MIN));
    expect(sent).toHaveLength(0);
  });

  it('alerts the operator outside WhatsApp after 5 minutes down, and when it recovers', async () => {
    const { monitor, alerts, set } = setup();
    const t0 = new Date('2026-10-18T09:00:00Z');
    set('qr');
    await monitor.check(t0);
    await monitor.check(new Date(t0.getTime() + 4 * MIN));
    expect(alerts).toEqual([]);
    await monitor.check(new Date(t0.getTime() + 5 * MIN));
    expect(alerts).toEqual(['whatsapp-down']);
    set('ready');
    await monitor.check(new Date(t0.getTime() + 9 * MIN));
    expect(alerts).toEqual(['whatsapp-down', 'whatsapp-down:resolved']);
  });
});
