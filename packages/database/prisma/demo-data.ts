/**
 * The fictional demo merchant shared by `seed` and `demo-reset`: Kampala Crafts, three
 * products and two customers. Upserts only — safe to run repeatedly.
 */
import type { Database } from '../src';

export const DEMO_MERCHANT_ID = 'seed_merchant_kampala_crafts';
export const DEMO_MERCHANT_NAME = 'Kampala Crafts';

export const DEMO_PRODUCTS = [
  {
    sku: 'KC-BASKET',
    category: 'Baskets',
    name: 'Handmade Basket',
    description: 'Woven raffia basket',
    unitPriceMinor: 1200,
    stockQuantity: 200,
    reorderLevel: 30,
    // Open to bargaining on WhatsApp down to $10.00; bulk buyers get 5% / 10% off.
    bargainingEnabled: true,
    minPriceMinor: 1000,
    quantityDiscounts: [
      { minQuantity: 5, percentOff: 5 },
      { minQuantity: 10, percentOff: 10 },
    ],
  },
  {
    sku: 'KC-WALLET',
    category: 'Leather and cloth',
    name: 'Barkcloth Wallet',
    description: 'Bi-fold wallet in barkcloth',
    unitPriceMinor: 1800,
    stockQuantity: 80,
    reorderLevel: 15,
    bargainingEnabled: true,
    minPriceMinor: 1500,
    quantityDiscounts: [],
  },
  {
    sku: 'KC-COFFEE',
    category: 'Food and gifts',
    name: 'Coffee Gift Pack',
    description: 'Arabica gift pack, 250 g',
    unitPriceMinor: 2500,
    stockQuantity: 120,
    reorderLevel: 20,
    // Fixed price: customers who ask are told politely that it isn't negotiable.
    bargainingEnabled: false,
    minPriceMinor: null,
    quantityDiscounts: [],
  },
];

export const DEMO_CUSTOMERS = [
  {
    id: 'seed_customer_sarah',
    name: 'Sarah Thompson',
    email: 'sarah.thompson@example.com',
    country: 'US',
  },
  {
    id: 'seed_customer_james',
    name: 'James Carter',
    email: 'james.carter@example.com',
    country: 'GB',
  },
];

/** Creates or restores the demo merchant, catalog (prices, stock, active) and customers. */
export async function upsertDemoData(db: Database): Promise<void> {
  await db.merchant.upsert({
    where: { id: DEMO_MERCHANT_ID },
    update: {},
    create: {
      id: DEMO_MERCHANT_ID,
      businessName: DEMO_MERCHANT_NAME,
      ownerName: 'Demo Owner',
      ownerEmail: 'owner@kampala-crafts.example',
      preferredCurrency: 'USD',
      preferredLanguage: 'en',
      timezone: 'Africa/Kampala',
    },
  });
  for (const p of DEMO_PRODUCTS) {
    await db.product.upsert({
      where: { merchantId_sku: { merchantId: DEMO_MERCHANT_ID, sku: p.sku } },
      update: {
        name: p.name,
        description: p.description,
        category: p.category,
        unitPriceMinor: p.unitPriceMinor,
        stockQuantity: p.stockQuantity,
        reorderLevel: p.reorderLevel,
        bargainingEnabled: p.bargainingEnabled,
        minPriceMinor: p.minPriceMinor,
        quantityDiscounts: p.quantityDiscounts,
        lowStockAlertedAt: null,
        active: true,
      },
      create: { ...p, merchantId: DEMO_MERCHANT_ID, currency: 'USD' },
    });
  }
  // Published for the demo; a real merchant's shop stays private until the owner publishes it.
  await db.storefront.upsert({
    where: { merchantId: DEMO_MERCHANT_ID },
    update: {},
    create: {
      merchantId: DEMO_MERCHANT_ID,
      slug: 'kampala-crafts',
      enabled: true,
      tagline: 'Handmade in Kampala, ordered on WhatsApp',
      about: 'Baskets, barkcloth and coffee from workshops around Kampala.',
    },
    select: { merchantId: true },
  });
  for (const c of DEMO_CUSTOMERS) {
    await db.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, email: c.email, country: c.country },
      create: { ...c, merchantId: DEMO_MERCHANT_ID, preferredCurrency: 'USD' },
    });
  }
  // The web dashboard's Agent console operates the merchant through the "web" channel.
  await db.merchantOperator.upsert({
    where: { channel_externalId: { channel: 'web', externalId: 'dashboard' } },
    update: { merchantId: DEMO_MERCHANT_ID },
    create: {
      merchantId: DEMO_MERCHANT_ID,
      name: 'Dashboard',
      channel: 'web',
      externalId: 'dashboard',
    },
  });
}
