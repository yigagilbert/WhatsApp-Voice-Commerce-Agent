/**
 * DEMO / DEVELOPMENT ONLY — resets the fictional Kampala Crafts merchant to a clean state.
 *
 *   DEMO_RESET_ALLOWED=true pnpm demo:reset --confirm kampala-crafts
 *   (VM) docker compose run --rm -e DEMO_RESET_ALLOWED=true api node dist/demo-reset.js --confirm kampala-crafts
 *
 * Deletes, for the demo merchant only: orders (and items), payments, shipments, disputes (local
 * copies only — nothing changes at PayPal), confirmations, messages,
 * audit events and customers created in conversations. Then restores the seeded catalog and
 * customers. Keeps: the merchant, its WhatsApp/web operators, conversations (emptied), all
 * configuration, the WhatsApp session and PayPal. Nothing is sent to PayPal or WhatsApp.
 *
 * Refuses to run unless ALL of these hold, so it can't be pointed at real data by accident:
 *   - DEMO_RESET_ALLOWED=true in the environment,
 *   - `--confirm kampala-crafts` on the command line,
 *   - PAYPAL_ENV is "sandbox",
 *   - the merchant is the seeded demo merchant ("Kampala Crafts").
 */
import { loadEnvFile } from '@vca/config';
import { createPrismaClient } from '@vca/database';
import {
  DEMO_CUSTOMERS,
  DEMO_MERCHANT_ID,
  DEMO_MERCHANT_NAME,
  upsertDemoData,
} from '../packages/database/prisma/demo-data';

loadEnvFile();

const CONFIRM_PHRASE = 'kampala-crafts';

function refuse(reason: string): never {
  console.error(`demo-reset refused: ${reason}`);
  console.error(
    `Usage (demo data only): DEMO_RESET_ALLOWED=true pnpm demo:reset --confirm ${CONFIRM_PHRASE}`,
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (process.env.DEMO_RESET_ALLOWED !== 'true') refuse('DEMO_RESET_ALLOWED is not "true".');
  if (args[args.indexOf('--confirm') + 1] !== CONFIRM_PHRASE || !args.includes('--confirm'))
    refuse(`missing "--confirm ${CONFIRM_PHRASE}".`);
  if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox')
    refuse('PAYPAL_ENV is not "sandbox". This command never runs against live payments.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) refuse('DATABASE_URL is not set.');

  const db = createPrismaClient({ databaseUrl });
  try {
    const merchant = await db.merchant.findUnique({ where: { id: DEMO_MERCHANT_ID } });
    if (merchant && merchant.businessName !== DEMO_MERCHANT_NAME)
      refuse(`merchant ${DEMO_MERCHANT_ID} is "${merchant.businessName}", not the demo merchant.`);

    const merchantId = DEMO_MERCHANT_ID;
    const seededCustomerIds = DEMO_CUSTOMERS.map((c) => c.id);
    const counts = await db.$transaction(async (tx) => {
      const disputes = await tx.dispute.deleteMany({ where: { merchantId } }); // responses cascade
      const shipments = await tx.shipment.deleteMany({ where: { merchantId } });
      const confirmations = await tx.actionConfirmation.deleteMany({ where: { merchantId } });
      const payments = await tx.payment.deleteMany({ where: { merchantId } });
      const orders = await tx.order.deleteMany({ where: { merchantId } }); // items cascade
      const messages = await tx.message.deleteMany({ where: { conversation: { merchantId } } });
      await tx.conversation.updateMany({ where: { merchantId }, data: { context: {} } });
      const audit = await tx.auditEvent.deleteMany({ where: { merchantId } });
      const customers = await tx.customer.deleteMany({
        where: { merchantId, id: { notIn: seededCustomerIds } },
      });
      return {
        disputes: disputes.count,
        shipments: shipments.count,
        confirmations: confirmations.count,
        payments: payments.count,
        orders: orders.count,
        messages: messages.count,
        auditEvents: audit.count,
        extraCustomers: customers.count,
      };
    });
    await upsertDemoData(db);
    console.log(`Demo data reset for ${DEMO_MERCHANT_NAME}. Removed:`, counts);
    console.log('Kept: merchant, operators, conversations, configuration, WhatsApp session.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
