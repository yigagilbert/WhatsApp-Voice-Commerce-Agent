/**
 * Development seed: an obviously fictional merchant ("Kampala Crafts"), three products
 * and two customers. Idempotent — safe to run repeatedly.
 *
 * Set SEED_MERCHANT_WHATSAPP_ID (e.g. "15550001111@c.us") to authorize a WhatsApp
 * identity to operate the merchant. Without it, no operator is created and WhatsApp
 * messages will be rejected as unknown senders.
 */
import { loadEnvFile } from '@vca/config';
import { createPrismaClient } from '../src/client';
import {
  DEMO_CUSTOMERS,
  DEMO_MERCHANT_ID,
  DEMO_MERCHANT_NAME,
  DEMO_PRODUCTS,
  upsertDemoData,
} from './demo-data';

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const db = createPrismaClient({ databaseUrl });

async function main() {
  await upsertDemoData(db);

  const operatorId = process.env.SEED_MERCHANT_WHATSAPP_ID?.trim();
  if (operatorId && !/^(\d{6,15}@c\.us|\d{6,20}@lid)$/.test(operatorId)) {
    throw new Error(
      `SEED_MERCHANT_WHATSAPP_ID '${operatorId}' is not a WhatsApp ID (expected e.g. 256700000000@c.us or …@lid)`,
    );
  }
  if (operatorId) {
    await db.merchantOperator.upsert({
      where: { channel_externalId: { channel: 'whatsapp', externalId: operatorId } },
      update: { merchantId: DEMO_MERCHANT_ID },
      create: {
        merchantId: DEMO_MERCHANT_ID,
        name: 'Demo Owner',
        channel: 'whatsapp',
        externalId: operatorId,
      },
    });
  }

  console.log(
    `Seeded ${DEMO_MERCHANT_NAME} (${DEMO_PRODUCTS.length} products, ${DEMO_CUSTOMERS.length} customers)` +
      (operatorId
        ? `, WhatsApp operator ${operatorId}`
        : ', no WhatsApp operator (SEED_MERCHANT_WHATSAPP_ID empty)'),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
