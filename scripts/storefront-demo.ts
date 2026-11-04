/**
 * DEMO / DEVELOPMENT ONLY: fills the seeded Kampala Crafts shop with a catalogue for trying the
 * storefront at scale, with generated product photos.
 *
 *   pnpm storefront:demo 120        (adds or refreshes demo products up to that many)
 *
 * Touches only the demo merchant and only products whose SKU starts with SF-, and refuses to run
 * against a live PayPal configuration.
 */
import { loadEnvFile } from '@vca/config';
import { createPrismaClient } from '@vca/database';
import sharp from 'sharp';
import { DEMO_MERCHANT_ID, upsertDemoData } from '../packages/database/prisma/demo-data';

loadEnvFile();

const CATALOGUE = [
  {
    category: 'Baskets',
    colors: ['#c98f4b', '#7a4b1f'],
    motif: 'weave',
    names: ['Raffia basket', 'Fruit bowl basket', 'Market tote', 'Laundry hamper', 'Bread basket'],
    text: 'Woven by hand from dyed raffia in Kampala.',
    price: 1600,
  },
  {
    category: 'Kitenge and fabric',
    colors: ['#d9472b', '#1f6f8b'],
    motif: 'dots',
    names: ['Kitenge wrap', 'Kitenge shirt', 'Cotton headwrap', 'Table runner', 'Cushion cover'],
    text: 'Bright wax-print cotton, cut and sewn in small batches.',
    price: 2400,
  },
  {
    category: 'Leather and barkcloth',
    colors: ['#6b3e26', '#c8a27a'],
    motif: 'stripes',
    names: ['Barkcloth wallet', 'Leather sandals', 'Card holder', 'Laptop sleeve', 'Belt'],
    text: 'Traditional barkcloth and vegetable-tanned leather.',
    price: 2800,
  },
  {
    category: 'Coffee and tea',
    colors: ['#2f4f3e', '#b98d58'],
    motif: 'circles',
    names: ['Arabica beans', 'Robusta beans', 'Gift pack', 'Ginger tea', 'Hibiscus tea'],
    text: 'Single-origin from the Rwenzori slopes, roasted this month.',
    price: 1400,
  },
  {
    category: 'Home and kitchen',
    colors: ['#3b6e4a', '#e6c56d'],
    motif: 'rings',
    names: ['Clay water pot', 'Banana fibre mat', 'Wooden spoon set', 'Serving board', 'Candle'],
    text: 'Everyday pieces from workshops around Lake Victoria.',
    price: 1900,
  },
] as const;

const motif = (kind: string, a: string, b: string) => {
  switch (kind) {
    case 'weave':
      return Array.from({ length: 9 }, (_, i) =>
        Array.from(
          { length: 9 },
          (_, j) =>
            `<rect x="${i * 90}" y="${j * 90}" width="88" height="88" rx="16" fill="${(i + j) % 2 ? a : b}"/>`,
        ).join(''),
      ).join('');
    case 'dots':
      return Array.from({ length: 8 }, (_, i) =>
        Array.from(
          { length: 8 },
          (_, j) =>
            `<circle cx="${i * 110 + 55}" cy="${j * 110 + 55}" r="${(i + j) % 3 ? 22 : 44}" fill="${b}"/>`,
        ).join(''),
      ).join('');
    case 'stripes':
      return Array.from(
        { length: 14 },
        (_, i) =>
          `<rect x="${i * 60}" y="0" width="${i % 3 ? 24 : 44}" height="800" fill="${b}" opacity="${i % 2 ? 0.55 : 0.9}"/>`,
      ).join('');
    case 'circles':
      return Array.from(
        { length: 7 },
        (_, i) => `<circle cx="400" cy="400" r="${380 - i * 54}" fill="${i % 2 ? a : b}"/>`,
      ).join('');
    default:
      return Array.from(
        { length: 6 },
        (_, i) =>
          `<circle cx="${i % 2 ? 260 : 540}" cy="${120 + i * 112}" r="150" fill="none" stroke="${b}" stroke-width="30"/>`,
      ).join('');
  }
};

const photo = async (kind: string, a: string, b: string, variant: number) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${a}"/><g transform="rotate(${variant * 22} 400 400)">${motif(kind, a, b)}</g></svg>`,
    ),
  )
    .modulate({ hue: variant * 26 })
    .jpeg({ quality: 80 })
    .toBuffer();

async function main() {
  const size = Number(process.argv[2] ?? 120);
  if (!Number.isInteger(size) || size < 1 || size > 5000)
    throw new Error('Choose 1 to 5000 products');
  if (process.env.PAYPAL_ENV === 'live') throw new Error('Refusing to run with PAYPAL_ENV=live');
  const db = createPrismaClient({ databaseUrl: process.env.DATABASE_URL! });
  await upsertDemoData(db);
  const main = new Map<string, Buffer>();
  const thumbs = new Map<string, Buffer>();
  for (let i = 0; i < size; i++) {
    const group = CATALOGUE[i % CATALOGUE.length]!;
    const base = group.names[Math.floor(i / CATALOGUE.length) % group.names.length]!;
    const round = Math.floor(i / (CATALOGUE.length * group.names.length));
    const name = round ? `${base} no. ${round + 1}` : base;
    const sku = `SF-${i}`;
    const stock = i % 17 === 0 ? 0 : i % 11 === 0 ? 3 : 20 + (i % 30);
    const product = await db.product.upsert({
      where: { merchantId_sku: { merchantId: DEMO_MERCHANT_ID, sku } },
      update: { name, category: group.category, active: true, visibleToCustomers: true },
      create: {
        merchantId: DEMO_MERCHANT_ID,
        sku,
        name,
        description: group.text,
        category: group.category,
        unitPriceMinor: group.price + (i % 12) * 100,
        currency: 'USD',
        stockQuantity: stock,
        reorderLevel: 3,
        bargainingEnabled: i % 4 === 0,
        minPriceMinor: i % 4 === 0 ? group.price - 200 : null,
        quantityDiscounts: i % 6 === 0 ? [{ minQuantity: 3, percentOff: 10 }] : [],
      },
    });
    // A few variations are enough: rotation and hue change them, and rows can share the bytes.
    const key = `${group.motif}:${i % 8}`;
    if (!main.has(key)) {
      const bytes = await photo(group.motif, group.colors[0], group.colors[1], i % 8);
      main.set(key, await sharp(bytes).resize(800).jpeg({ quality: 80 }).toBuffer());
      thumbs.set(key, await sharp(bytes).resize(320).jpeg({ quality: 76 }).toBuffer());
    }
    const fields = {
      mimeType: 'image/jpeg',
      storage: 'DATABASE' as const,
      data: new Uint8Array(main.get(key)!),
      thumbData: new Uint8Array(thumbs.get(key)!),
      sizeBytes: main.get(key)!.length,
      width: 800,
      height: 800,
    };
    await db.productImage.upsert({
      where: { productId: product.id },
      update: fields,
      create: { productId: product.id, ...fields },
      select: { id: true },
    });
  }
  console.log(`Demo storefront ready with ${size} generated products.`);
  await db.$disconnect();
}

void main();
