/**
 * pnpm paypal:webhook list
 * pnpm paypal:webhook register https://<domain>/api/paypal/webhooks
 * pnpm paypal:webhook sync https://<domain>/api/paypal/webhooks   (update an existing webhook's events)
 *
 * Registers the Katale AI webhook (Orders v2 / Payments v2 events) for the PayPal REST app in
 * .env via PayPal's API — no dashboard clicks. Idempotent: an existing webhook for the same URL is
 * reused. Prints the webhook ID to put in PAYPAL_WEBHOOK_ID on the server. Sandbox only by default.
 */
import { loadEnvFile, parseConfig, paypalSchema } from '@vca/config';
import { HANDLED_WEBHOOK_EVENTS, PayPalClient } from '@vca/paypal';
import { isAppError } from '@vca/shared';

loadEnvFile();

async function main() {
  const config = parseConfig(paypalSchema);
  const client = new PayPalClient({
    environment: config.PAYPAL_ENV,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
  const [command, url] = process.argv.slice(2);

  if (command === 'list') {
    const hooks = await client.listWebhooks();
    if (!hooks.length) console.log(`No webhooks registered (${config.PAYPAL_ENV}).`);
    for (const h of hooks)
      console.log(`${h.id}  ${h.url}  [${h.event_types.map((e) => e.name).join(', ')}]`);
    return;
  }

  if (command === 'register') {
    if (!url || !/^https:\/\/[^/]+\/api\/paypal\/webhooks$/.test(url)) {
      throw new Error('Usage: pnpm paypal:webhook register https://<domain>/api/paypal/webhooks');
    }
    const existing = (await client.listWebhooks()).find((h) => h.url === url);
    if (existing) {
      console.log(`Webhook already registered for ${url} (use "sync" to update its events)`);
      console.log(`PAYPAL_WEBHOOK_ID=${existing.id}`);
      return;
    }
    const created = await client.createWebhook(url, HANDLED_WEBHOOK_EVENTS);
    console.log(
      `Registered ${url} (${config.PAYPAL_ENV}) for: ${HANDLED_WEBHOOK_EVENTS.join(', ')}`,
    );
    console.log(`PAYPAL_WEBHOOK_ID=${created.id}`);
    return;
  }

  if (command === 'sync') {
    // Subscribes an existing webhook to exactly the events Katale handles (no more, no fewer).
    const existing = (await client.listWebhooks()).find((h) => h.url === url);
    if (!existing) throw new Error(`No webhook registered for ${url}; use "register" first.`);
    const have = existing.event_types.map((e) => e.name).sort();
    const want = [...HANDLED_WEBHOOK_EVENTS].sort();
    if (have.join() === want.join()) {
      console.log(`Webhook ${existing.id} already subscribes to: ${want.join(', ')}`);
      return;
    }
    const updated = await client.updateWebhookEvents(existing.id, HANDLED_WEBHOOK_EVENTS);
    console.log(`Updated ${existing.id}: ${updated.event_types.map((e) => e.name).join(', ')}`);
    return;
  }

  throw new Error('Usage: pnpm paypal:webhook list | register <https-url> | sync <https-url>');
}

main().catch((error: unknown) => {
  console.error(
    isAppError(error)
      ? `${error.message} ${JSON.stringify(error.details ?? '')}`
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exitCode = 1;
});
