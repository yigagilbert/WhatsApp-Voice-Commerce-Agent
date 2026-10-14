/**
 * pnpm operator:add <whatsappId> [name] [--merchant <merchantId>]
 *
 * Authorizes a WhatsApp identity to operate a merchant (default: the seeded Kampala Crafts merchant).
 * A WhatsApp ID maps to exactly one merchant (unique constraint); re-running moves it explicitly
 * only if --merchant is given.
 *
 * Accepted formats (what the API logs for unknown senders):
 *   256700000000@c.us   phone-number ID: country code + number, no "+" or spaces
 *   123456789012345@lid linked ID that newer WhatsApp versions use instead of the phone number
 */
import { loadEnvFile } from '@vca/config';
import { createPrismaClient } from '@vca/database';

loadEnvFile();

const WHATSAPP_ID = /^(\d{6,15}@c\.us|\d{6,20}@lid)$/;
const DEFAULT_MERCHANT_ID = 'seed_merchant_kampala_crafts';

async function main() {
  const args = process.argv.slice(2);
  const merchantFlag = args.indexOf('--merchant');
  const merchantId = merchantFlag >= 0 ? args[merchantFlag + 1] : undefined;
  const positional = args.filter(
    (_, i) => merchantFlag < 0 || (i !== merchantFlag && i !== merchantFlag + 1),
  );
  const [rawId, ...nameParts] = positional;

  if (!rawId || !WHATSAPP_ID.test(rawId.trim())) {
    console.error('Usage: pnpm operator:add <whatsappId> [name] [--merchant <merchantId>]');
    console.error('whatsappId must look like 256700000000@c.us or 123456789012345@lid');
    process.exitCode = 1;
    return;
  }
  const externalId = rawId.trim();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const db = createPrismaClient({ databaseUrl });

  try {
    const targetId = merchantId ?? DEFAULT_MERCHANT_ID;
    const merchant = await db.merchant.findUnique({ where: { id: targetId } });
    if (!merchant) throw new Error(`Merchant '${targetId}' not found (run pnpm db:seed?)`);

    const existing = await db.merchantOperator.findUnique({
      where: { channel_externalId: { channel: 'whatsapp', externalId } },
    });
    if (existing && existing.merchantId !== merchant.id && !merchantId) {
      throw new Error(
        `${externalId} already operates merchant ${existing.merchantId}; pass --merchant to move it.`,
      );
    }
    await db.merchantOperator.upsert({
      where: { channel_externalId: { channel: 'whatsapp', externalId } },
      update: {
        merchantId: merchant.id,
        ...(nameParts.length ? { name: nameParts.join(' ') } : {}),
      },
      create: {
        merchantId: merchant.id,
        channel: 'whatsapp',
        externalId,
        name: nameParts.join(' ') || 'Merchant',
      },
    });
    console.log(`✔ ${externalId} can now operate "${merchant.businessName}" over WhatsApp.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
