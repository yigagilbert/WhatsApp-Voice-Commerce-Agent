/**
 * pnpm paypal:smoke [capture <PAYPAL_ORDER_ID>]
 *
 * SANDBOX ONLY. Exercises the PayPal client directly (no database, no agent):
 *   1. OAuth token
 *   2. Create a USD 1.00 checkout order (same request shape the app uses)
 *   3. Read it back (GET)
 *   4. Try to capture before approval → expect ORDER_NOT_APPROVED
 * Then approve the printed link with a Sandbox buyer and run:
 *   pnpm paypal:smoke capture <PAYPAL_ORDER_ID>
 * which captures, replays the same PayPal-Request-Id (idempotent), and captures again with a
 * new key (must not create a second capture).
 */
import { randomUUID } from 'node:crypto';
import { loadEnvFile, parseConfig, paypalSchema } from '@vca/config';
import { PayPalClient, payPalErrorIssues } from '@vca/paypal';

loadEnvFile();

const config = parseConfig(paypalSchema);
if (config.PAYPAL_ENV !== 'sandbox') {
  console.error('Refusing to run: PAYPAL_ENV must be "sandbox".');
  process.exit(1);
}
const client = new PayPalClient({
  environment: 'sandbox',
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
});
const publicUrl = (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const results: [string, 'PASS' | 'FAIL', string?][] = [];
const record = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok ? 'PASS' : 'FAIL', note]);
  console.log(`${ok ? '✔' : '✘'} ${name}${note ? ` — ${note}` : ''}`);
};

async function expectIssue(name: string, issue: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    record(name, false, `expected ${issue}, but the call succeeded`);
  } catch (error) {
    const issues = payPalErrorIssues(error);
    record(name, issues.includes(issue), issues.length ? issues.join(',') : String(error));
  }
}

async function createFlow() {
  const auth = await client.checkCredentials();
  record('OAuth token', true, `expires in ${auth.expiresInSeconds}s`);

  const smokeId = `smoke-${randomUUID()}`;
  const params = {
    requestId: smokeId,
    referenceId: 'SMOKE-TEST',
    customId: smokeId.slice(0, 40),
    description: 'Katale AI sandbox smoke test',
    currency: 'USD',
    items: [{ name: 'Smoke test item', quantity: 2, unitAmount: '0.40' }],
    itemTotal: '0.80',
    shipping: '0.20',
    taxTotal: '0.00',
    total: '1.00',
    returnUrl: `${publicUrl}/api/paypal/return`,
    cancelUrl: `${publicUrl}/api/paypal/cancel`,
    brandName: config.PAYPAL_BRAND_NAME,
  };
  const { order, approveUrl } = await client.createCheckoutOrder(params);
  record('Create order', !!order.id, `${order.id} status=${order.status}`);
  record('Approval URL', /^https:\/\/www\.sandbox\.paypal\.com\//.test(approveUrl), approveUrl);

  const replay = await client.createCheckoutOrder(params);
  record(
    'Create idempotency (same PayPal-Request-Id)',
    replay.order.id === order.id,
    replay.order.id,
  );

  const fetched = await client.getOrder(order.id);
  record('Get order', fetched.id === order.id, `status=${fetched.status}`);

  await expectIssue('Capture before approval rejected', 'ORDER_NOT_APPROVED', () =>
    client.captureOrder(order.id, `capture-${smokeId}`),
  );

  console.log(
    `\nNext: open the approval URL, log in with a Sandbox *personal* account, approve, then run:`,
  );
  console.log(`  pnpm paypal:smoke capture ${order.id}`);
}

async function captureFlow(orderId: string) {
  const key = `capture-smoke-${orderId}`;
  const first = await client.captureOrder(orderId, key);
  const capture = first.purchase_units?.[0]?.payments?.captures?.[0];
  record(
    'Capture',
    first.status === 'COMPLETED',
    `order=${first.status} capture=${capture?.id} ${capture?.status}`,
  );

  const replay = await client.captureOrder(orderId, key);
  const replayCapture = replay.purchase_units?.[0]?.payments?.captures?.[0];
  record(
    'Capture replay (same PayPal-Request-Id)',
    replayCapture?.id === capture?.id,
    replayCapture?.id,
  );

  // A capture with a NEW key must not move money twice. Observed Sandbox behaviour (2026-10):
  // 200 with the existing single capture; PayPal also documents 422 ORDER_ALREADY_CAPTURED.
  // Both are safe and both are handled by PaymentService.captureApproved.
  try {
    const second = await client.captureOrder(orderId, `capture-smoke-${randomUUID()}`);
    const captures = second.purchase_units?.[0]?.payments?.captures ?? [];
    record(
      'Second capture (new key) creates no new capture',
      captures.length === 1 && captures[0]?.id === capture?.id,
      `returned ${captures.length} capture(s): ${captures.map((c) => c.id).join(',')}`,
    );
  } catch (error) {
    const issues = payPalErrorIssues(error);
    record(
      'Second capture (new key) creates no new capture',
      issues.includes('ORDER_ALREADY_CAPTURED'),
      issues.join(','),
    );
  }
  const after = await client.getOrder(orderId);
  record('Get order after capture', after.status === 'COMPLETED', `status=${after.status}`);
}

async function main() {
  const [command, orderId] = process.argv.slice(2);
  try {
    if (command === 'capture') {
      if (!orderId) throw new Error('Usage: pnpm paypal:smoke capture <PAYPAL_ORDER_ID>');
      await captureFlow(orderId);
    } else {
      await createFlow();
    }
  } catch (error) {
    record('Unexpected error', false, error instanceof Error ? error.message : String(error));
  }
  if (results.some(([, status]) => status === 'FAIL')) process.exitCode = 1;
}

void main();
