import { describe, expect, it } from 'vitest';
import { createLogger } from '@vca/shared';
import { OpsAlerts } from './ops-alerts';

const logger = createLogger({ name: 't', level: 'silent' });

function setup(fail = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (fail) throw new Error('network down');
    return new Response('ok');
  }) as unknown as typeof fetch;
  const alerts = new OpsAlerts({
    webhookUrl: 'https://ntfy.example/katale-topic',
    heartbeatUrl: 'https://hc.example/ping/abc',
    logger,
    fetch: fetchImpl,
  });
  return { alerts, calls };
}

describe('ops alerts', () => {
  it('posts a plain-text alert with ntfy metadata', async () => {
    const { alerts, calls } = setup();
    expect(await alerts.alert('k', 'PayPal webhook failed', 'details')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ntfy.example/katale-topic');
    expect(calls[0]!.init.body).toBe('PayPal webhook failed\n\ndetails');
    expect((calls[0]!.init.headers as Record<string, string>).Title).toBe(
      'Katale AI: PayPal webhook failed',
    );
  });

  it('sends the same alert at most once per window', async () => {
    const { alerts, calls } = setup();
    const t = Date.now();
    await alerts.alert('k', 'a', 'b', t);
    await alerts.alert('k', 'a', 'b', t + 60_000);
    await alerts.alert('other', 'a', 'b', t + 60_000);
    await alerts.alert('k', 'a', 'b', t + 31 * 60_000);
    expect(calls).toHaveLength(3);
  });

  it('sends "resolved" only for keys that alerted', async () => {
    const { alerts, calls } = setup();
    await alerts.resolve('never', 'ok', 'ok');
    expect(calls).toHaveLength(0);
    await alerts.alert('down', 'down', 'x');
    await alerts.resolve('down', 'back', 'y');
    expect(calls).toHaveLength(2);
    // After resolving, a new outage alerts again immediately.
    await alerts.alert('down', 'down', 'x');
    expect(calls).toHaveLength(3);
  });

  it('never throws when the alert endpoint is down', async () => {
    const { alerts } = setup(true);
    await expect(alerts.alert('k', 'a', 'b')).resolves.toBe(false);
    await expect(alerts.heartbeat()).resolves.toBeUndefined();
  });

  it('pings the heartbeat at most every 5 minutes', async () => {
    const { alerts, calls } = setup();
    const t = Date.now();
    await alerts.heartbeat(t);
    await alerts.heartbeat(t + 60_000);
    await alerts.heartbeat(t + 5 * 60_000);
    expect(calls.map((c) => c.url)).toEqual([
      'https://hc.example/ping/abc',
      'https://hc.example/ping/abc',
    ]);
  });

  it('is a no-op without configuration', async () => {
    const quiet = new OpsAlerts({ logger });
    expect(quiet.configured).toBe(false);
    expect(await quiet.alert('k', 'a', 'b')).toBe(false);
  });
});
