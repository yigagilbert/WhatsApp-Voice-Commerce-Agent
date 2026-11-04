/**
 * DEMO / DEVELOPMENT ONLY: fictional shops with months of history for trying the Overview at
 * realistic scale. Every awkward case the dashboard must get right is present: partial and full
 * refunds, a duplicate payment, unpaid and expired links, disputes, low and zero stock, and sales in
 * two currencies. The second shop proves merchant isolation.
 *
 *   pnpm overview:demo            (default: 480 orders over 120 days)
 *   pnpm overview:demo 3000       (larger shop, for performance checks)
 *
 * A third, empty shop shows the first-run experience.
 *
 * Replaces only these shops. Runs only against a local database, and never with live PayPal. Generated
 * with a fixed seed, so figures are comparable between runs on the same day.
 */
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from '@vca/config';
import { createPrismaClient, type Database } from '@vca/database';
import { hashPassword } from '../packages/commerce/src/services/dashboard-user.service';

loadEnvFile();

/** Local-only test accounts for the two fictional shops. */
const DEMO_ACCOUNTS = [
  { merchantId: 'demo_overview_shop', username: 'overview-demo', name: 'Demo Owner' },
  { merchantId: 'demo_overview_other', username: 'overview-other', name: 'Other Owner' },
  { merchantId: 'demo_overview_new', username: 'overview-new', name: 'New Owner' },
];
const TEST_PASSWORD = 'katale-overview-demo-1';

const DAY = 86_400_000;

/** Small deterministic generator (mulberry32). */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CATALOGUE = [
  ['Raffia basket', 'Baskets', 2800, 42, 10],
  ['Market tote', 'Baskets', 3600, 6, 10],
  ['Kitenge wrap', 'Fabric', 2400, 57, 12],
  ['Kitenge shirt', 'Fabric', 4200, 18, 6],
  ['Barkcloth wallet', 'Leather', 1900, 0, 5],
  ['Leather sandals', 'Leather', 5400, 3, 4],
  ['Arabica beans 500g', 'Coffee', 1600, 120, 25],
  ['Gift pack', 'Coffee', 4800, 22, 5],
  ['Ginger tea', 'Coffee', 900, 0, 10],
  ['Clay water pot', 'Home', 3100, 9, 3],
  ['Banana fibre mat', 'Home', 2200, null, null],
  ['Serving board', 'Home', 2600, 14, 4],
] as const;
const CUSTOMERS = [
  'Sarah Namukasa',
  'John Okello',
  'Grace Atim',
  'Peter Mugisha',
  'Amina Nabirye',
  'David Ssemakula',
  'Ruth Akello',
  'Moses Kato',
  'Joy Nansubuga',
  'Brian Tumwine',
  'Esther Achieng',
  'Paul Wasswa',
  'Maria Lopez',
  'Tom Becker',
  'Lena Fischer',
  'Priya Nair',
  'Kofi Mensah',
  'Aisha Bello',
];
const SOURCES = [
  ['whatsapp', 'VOICE', 0.42],
  ['whatsapp', 'TEXT', 0.36],
  ['storefront', 'TEXT', 0.14],
  ['web', 'TEXT', 0.08],
] as const;

async function removeShop(db: Database, merchantId: string) {
  await db.dispute.deleteMany({ where: { merchantId } });
  await db.order.deleteMany({ where: { merchantId } });
  await db.merchant.deleteMany({ where: { id: merchantId } });
}

async function buildShop(
  db: Database,
  shop: { id: string; name: string; orders: number; days: number; seed: number },
) {
  const random = generator(shop.seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T;
  const now = Date.now();

  await db.merchant.create({
    data: {
      id: shop.id,
      businessName: shop.name,
      ownerName: 'Demo Owner',
      preferredCurrency: 'USD',
      timezone: 'Africa/Kampala',
    },
  });
  const products = await Promise.all(
    CATALOGUE.map(([name, category, price, stock, reorder], i) =>
      db.product.create({
        data: {
          merchantId: shop.id,
          name,
          category,
          sku: `DEMO-${i + 1}`,
          unitPriceMinor: price,
          currency: 'USD',
          stockQuantity: stock,
          reorderLevel: reorder,
        },
      }),
    ),
  );
  const customers = await Promise.all(
    CUSTOMERS.map((name) =>
      db.customer.create({ data: { merchantId: shop.id, name, country: 'UG' } }),
    ),
  );

  for (let n = 0; n < shop.orders; n++) {
    // Recent days are busier, so the trend has a shape.
    const age = Math.floor(Math.pow(random(), 1.6) * shop.days);
    const createdAt = new Date(now - age * DAY - random() * DAY * 0.9);
    if (createdAt.getTime() > now) continue;
    const roll = random();
    let source: (typeof SOURCES)[number] = SOURCES[0];
    let edge = 0;
    for (const candidate of SOURCES) {
      edge += candidate[2];
      if (roll <= edge) {
        source = candidate;
        break;
      }
    }
    // One order in twelve sells in shillings: a second currency that must never be added to USD.
    const ugx = random() < 0.08;
    const currency = ugx ? 'UGX' : 'USD';
    const chosen = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(products));
    const items = chosen.map((product, position) => {
      const quantity = 1 + Math.floor(random() * 3);
      const unitPriceMinor = ugx
        ? Math.round((product.unitPriceMinor / 100) * 3700)
        : product.unitPriceMinor;
      return {
        productId: ugx ? null : product.id,
        description: product.name,
        quantity,
        unitPriceMinor,
        lineTotalMinor: unitPriceMinor * quantity,
        position,
      };
    });
    const subtotalMinor = items.reduce((sum, i) => sum + i.lineTotalMinor, 0);
    const shippingMinor = ugx ? 15_000 : 800;
    const totalMinor = subtotalMinor + shippingMinor;

    const outcome = random();
    const open = age <= 3 && outcome < 0.35;
    const expired = !open && outcome < 0.1;
    const cancelled = !open && !expired && outcome < 0.14;
    const paid = !open && !expired && !cancelled;
    const fullRefund = paid && random() < 0.03;
    const partialRefund = paid && !fullRefund && random() < 0.05;
    const refundedMinor = fullRefund
      ? totalMinor
      : partialRefund
        ? Math.round(totalMinor * 0.3)
        : 0;
    // Never in the future: a payment can't have completed yet that hasn't happened.
    const completedAt = new Date(
      Math.min(createdAt.getTime() + random() * 6 * 3_600_000, now - 60_000),
    );
    const shipped = paid && !fullRefund && age > 4 + random() * 6;
    const customer = pick(customers);

    const order = await db.order.create({
      data: {
        reference: `D${shop.seed}-${String(n).padStart(5, '0')}`,
        merchantId: shop.id,
        customerId: customer.id,
        status: fullRefund ? 'REFUNDED' : paid ? 'PAID' : open ? 'AWAITING_PAYMENT' : 'CANCELLED',
        currency,
        subtotalMinor,
        shippingMinor,
        totalMinor,
        refundedMinor,
        source: source[0],
        inputMode: source[1],
        fulfillmentStatus: shipped ? 'SHIPPED' : 'NOT_SHIPPED',
        createdAt,
        ...(open ? { paymentDueAt: new Date(now + (random() < 0.5 ? 0.5 : 2) * DAY) } : {}),
        ...(expired || cancelled
          ? {
              cancelledAt: new Date(createdAt.getTime() + DAY),
              cancelReason: expired ? ('PAYMENT_EXPIRED' as const) : ('MERCHANT' as const),
            }
          : {}),
        items: { create: items },
      },
    });
    const payment = await db.payment.create({
      data: {
        merchantId: shop.id,
        orderId: order.id,
        provider: 'PAYPAL',
        kind: 'CHECKOUT_ORDER',
        externalId: `DEMO-${randomUUID()}`,
        status: fullRefund ? 'REFUNDED' : paid ? 'COMPLETED' : open ? 'CREATED' : 'CANCELLED',
        amountMinor: totalMinor,
        currency,
        refundedMinor,
        idempotencyKey: randomUUID(),
        createdAt,
        ...(paid ? { completedAt } : {}),
      },
    });
    if (refundedMinor > 0)
      await db.refund.create({
        data: {
          merchantId: shop.id,
          orderId: order.id,
          paymentId: payment.id,
          provider: 'PAYPAL',
          externalId: `DEMO-REFUND-${randomUUID()}`,
          amountMinor: refundedMinor,
          currency,
          status: 'COMPLETED',
        },
      });
    if (shipped)
      await db.shipment.create({
        data: {
          merchantId: shop.id,
          orderId: order.id,
          paymentId: payment.id,
          carrier: pick(['DHL', 'UPS', 'FEDEX']),
          trackingNumber: `TRK${shop.seed}${n}`,
          shippedAt: new Date(completedAt.getTime() + DAY),
        },
      });
    // A customer paid an older link a second time: the money must not count as a second sale.
    if (paid && !fullRefund && n % 97 === 11) {
      await db.payment.create({
        data: {
          merchantId: shop.id,
          orderId: order.id,
          provider: 'PAYPAL',
          kind: 'CHECKOUT_ORDER',
          externalId: `DEMO-${randomUUID()}`,
          status: 'COMPLETED',
          amountMinor: totalMinor,
          currency,
          duplicate: true,
          idempotencyKey: randomUUID(),
          createdAt,
          completedAt: new Date(Math.min(completedAt.getTime() + 3_600_000, now - 60_000)),
        },
      });
      await db.order.update({
        where: { id: order.id },
        data: { attention: 'DUPLICATE_PAYMENT', attentionAt: new Date() },
      });
    }
    if (paid && !fullRefund && n % 83 === 7)
      await db.dispute.create({
        data: {
          merchantId: shop.id,
          orderId: order.id,
          paymentId: payment.id,
          paypalDisputeId: `PP-D-DEMO-${shop.seed}-${n}`,
          reason: pick(['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'UNAUTHORISED']),
          status: n % 2 ? 'WAITING_FOR_SELLER_RESPONSE' : 'UNDER_REVIEW',
          amountMinor: totalMinor,
          currency,
          openedAt: completedAt,
          sellerResponseDueAt: new Date(now + (2 + (n % 8)) * DAY),
        },
      });
  }
}

async function main() {
  if ((process.env.PAYPAL_ENV ?? 'sandbox') === 'live')
    throw new Error('Refusing to generate demo data against a live PayPal configuration.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  // These accounts share a password that is in this file, so they must never reach a shared server.
  // PayPal Sandbox alone doesn't prove that: a hosted environment can run on Sandbox too.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname))
    throw new Error('Refusing to generate demo accounts outside a local database.');
  const db = createPrismaClient({ databaseUrl });
  const size = Number(process.argv[2] ?? 480);
  try {
    for (const account of DEMO_ACCOUNTS) await removeShop(db, account.merchantId);
    await buildShop(db, {
      id: 'demo_overview_shop',
      name: 'Kampala Crafts Co.',
      orders: size,
      days: 120,
      seed: 7,
    });
    await buildShop(db, {
      id: 'demo_overview_other',
      name: 'Lakeside Coffee',
      orders: 40,
      days: 30,
      seed: 11,
    });
    await buildShop(db, {
      id: 'demo_overview_new',
      name: 'Brand New Shop',
      orders: 0,
      days: 1,
      seed: 13,
    });
    const passwordHash = await hashPassword(TEST_PASSWORD);
    for (const account of DEMO_ACCOUNTS)
      await db.dashboardUser.create({
        data: {
          merchantId: account.merchantId,
          username: account.username,
          name: account.name,
          role: 'OWNER',
          passwordHash,
        },
      });
    console.log(
      `Demo shops ready: ${size} and 40 orders. Sign in as ${DEMO_ACCOUNTS.map((a) => a.username).join(' or ')}; the test password is in scripts/overview-demo.ts.`,
    );
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
