/**
 * SANDBOX dispute tooling (never touches live PayPal):
 *
 *   pnpm paypal:dispute list                       disputes on the Sandbox business account
 *   pnpm paypal:dispute show <dispute-id>          status, reason, amount, disputed capture
 *   pnpm paypal:dispute require-evidence <id>      Sandbox-only: UNDER_REVIEW → WAITING_FOR_SELLER_RESPONSE
 *
 * Disputes themselves are opened by the Sandbox *buyer* on sandbox.paypal.com (Activity → the
 * payment → "Report a problem"). PayPal then sends CUSTOMER.DISPUTE.* webhooks to Katale.
 */
import { loadEnvFile, parseConfig, paypalSchema } from '@vca/config';
import { PayPalClient } from '@vca/paypal';
import { isAppError } from '@vca/shared';

loadEnvFile();

async function main() {
  const config = parseConfig(paypalSchema);
  if (config.PAYPAL_ENV !== 'sandbox') throw new Error('paypal:dispute is Sandbox-only.');
  const client = new PayPalClient({
    environment: 'sandbox',
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
  const [command, id] = process.argv.slice(2);
  if (command === 'list') {
    const items = await client.listDisputes({ pageSize: 50 });
    if (!items.length) console.log('No disputes on this Sandbox account.');
    for (const d of items)
      console.log(
        `${d.dispute_id}  ${d.status}  ${d.reason}  ${d.dispute_amount?.value ?? ''} ${d.dispute_amount?.currency_code ?? ''}`,
      );
    return;
  }
  if (!id) throw new Error('Usage: pnpm paypal:dispute list | show <id> | require-evidence <id>');
  if (command === 'show') {
    const d = await client.getDispute(id);
    console.log({
      id: d.dispute_id,
      status: d.status,
      reason: d.reason,
      stage: d.dispute_life_cycle_stage,
      amount: d.dispute_amount,
      sellerResponseDue: d.seller_response_due_date,
      disputedCapture: d.disputed_transactions?.[0]?.seller_transaction_id,
      actions: (d.links ?? []).map((l) => l.rel),
    });
    return;
  }
  if (command === 'require-evidence') {
    await client.sandboxRequireSellerEvidence(id);
    console.log(
      `Requested seller evidence for ${id} (Sandbox). PayPal sends CUSTOMER.DISPUTE.UPDATED.`,
    );
    return;
  }
  throw new Error('Usage: pnpm paypal:dispute list | show <id> | require-evidence <id>');
}

main().catch((error: unknown) => {
  console.error(
    isAppError(error) ? `${error.message} ${JSON.stringify(error.details ?? '')}` : error,
  );
  process.exitCode = 1;
});
