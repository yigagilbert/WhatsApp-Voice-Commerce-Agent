/**
 * DEMO / DEVELOPMENT ONLY: fills the seeded Kampala Crafts shop with a catalogue for trying the
 * storefront at scale, with generated placeholder images (not real photographs).
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
    shape: 'basket',
    colors: [
      ['#c6965a', 'Natural'],
      ['#a8743d', 'Honey'],
      ['#8f9a5b', 'Olive'],
      ['#b5654a', 'Terracotta'],
      ['#7d8fa3', 'Lake blue'],
      ['#d0ad72', 'Straw'],
    ],
    names: ['raffia basket', 'fruit basket', 'market basket', 'laundry basket', 'bread basket'],
    text: 'Woven by hand from dyed raffia in Kampala.',
    price: 1600,
  },
  {
    category: 'Kitenge and fabric',
    shape: 'fabric',
    colors: [
      ['#b5472f', 'Rust'],
      ['#256d85', 'Teal'],
      ['#a9782a', 'Ochre'],
      ['#4d6f4f', 'Forest'],
      ['#6b4e8a', 'Plum'],
      ['#c2593f', 'Coral'],
    ],
    names: ['kitenge wrap', 'cotton throw', 'headwrap', 'table runner', 'cushion cover'],
    text: 'Bright wax-print cotton, cut and sewn in small batches.',
    price: 2400,
  },
  {
    category: 'Leather and barkcloth',
    shape: 'wallet',
    colors: [
      ['#6b3e26', 'Chestnut'],
      ['#8a5a3a', 'Tan'],
      ['#3f3a36', 'Charcoal'],
      ['#a06a3f', 'Caramel'],
      ['#59402e', 'Walnut'],
      ['#7a4a2a', 'Cognac'],
    ],
    names: ['barkcloth wallet', 'leather wallet', 'card holder', 'travel pouch', 'coin purse'],
    text: 'Traditional barkcloth and vegetable-tanned leather.',
    price: 2800,
  },
  {
    category: 'Coffee and tea',
    shape: 'pouch',
    colors: [
      ['#2f4f3e', 'Highland'],
      ['#1f2937', 'Dark roast'],
      ['#7a4a2a', 'Medium roast'],
      ['#8c2f39', 'Berry'],
      ['#3d5a80', 'Lake'],
      ['#57534e', 'Stone'],
    ],
    names: ['arabica coffee', 'robusta coffee', 'gift pack', 'ginger tea', 'hibiscus tea'],
    text: 'Single-origin from the Rwenzori slopes, roasted this month.',
    price: 1400,
  },
  {
    category: 'Home and kitchen',
    shape: 'pot',
    colors: [
      ['#b5654a', 'Terracotta'],
      ['#8c5a3c', 'Clay'],
      ['#9a8a72', 'Sand'],
      ['#4f6d6a', 'Sage'],
      ['#a24b36', 'Brick'],
      ['#6e6259', 'Ash'],
    ],
    names: ['water pot', 'serving bowl', 'storage jar', 'planter', 'flower vase'],
    text: 'Everyday pieces from workshops around Lake Victoria.',
    price: 1900,
  },
] as const;

const SHAPES: Record<string, (color: string) => string> = {
  basket: (c) => {
    const rows = Array.from({ length: 7 }, (_, i) => {
      const y = 520 + i * 44;
      const inset = 250 + i * 12;
      return `<rect x="${inset}" y="${y}" width="${1200 - inset * 2}" height="34" rx="17" fill="${c}" opacity="${i % 2 ? 0.86 : 1}"/>`;
    }).join('');
    return `<path d="M340 530C340 300 860 300 860 530" fill="none" stroke="${c}" stroke-width="30" stroke-linecap="round"/>${rows}`;
  },
  fabric: (c) =>
    [0, 1, 2]
      .map((i) => {
        const y = 620 - i * 104;
        const dots = Array.from(
          { length: 9 },
          (_, d) =>
            `<circle cx="${350 + d * 62}" cy="${y + 56}" r="14" fill="#ffffff" opacity="0.5"/>`,
        ).join('');
        return `<rect x="300" y="${y}" width="600" height="112" rx="26" fill="${c}" opacity="${1 - i * 0.14}"/>${dots}`;
      })
      .join(''),
  wallet: (c) =>
    `<rect x="290" y="390" width="620" height="420" rx="44" fill="${c}"/><path d="M290 560h620v-126a44 44 0 0 0-44-44H334a44 44 0 0 0-44 44Z" fill="#ffffff" opacity="0.1"/><rect x="326" y="426" width="548" height="348" rx="26" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="5" stroke-dasharray="16 13"/><circle cx="830" cy="560" r="24" fill="#ffffff" opacity="0.65"/>`,
  pouch: (c) =>
    `<path d="M380 300h440l46 520a40 40 0 0 1-40 44H374a40 40 0 0 1-40-44Z" fill="${c}"/><rect x="380" y="282" width="440" height="52" rx="14" fill="${c}"/><rect x="380" y="282" width="440" height="52" rx="14" fill="#ffffff" opacity="0.12"/><rect x="450" y="490" width="300" height="220" rx="16" fill="#f8fafc"/><rect x="490" y="540" width="220" height="16" rx="8" fill="${c}"/><rect x="520" y="580" width="160" height="12" rx="6" fill="${c}" opacity="0.5"/><rect x="520" y="612" width="160" height="12" rx="6" fill="${c}" opacity="0.5"/>`,
  pot: (c) =>
    `<ellipse cx="600" cy="360" rx="130" ry="30" fill="${c}"/><path d="M490 360c0 70-190 130-190 270 0 150 130 220 300 220s300-70 300-220c0-140-190-200-190-270Z" fill="${c}"/><path d="M322 600c80 44 476 44 556 0" fill="none" stroke="#ffffff" stroke-opacity="0.32" stroke-width="10"/><path d="M314 650c90 50 482 50 572 0" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="10"/><ellipse cx="600" cy="360" rx="96" ry="18" fill="#111827" opacity="0.28"/>`,
};

/** A plain studio-style placeholder: one object on a soft neutral background. Not a photograph. */
const photo = (shape: string, color: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#eef2f6"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="26"/></filter></defs><rect width="1200" height="1200" fill="url(#bg)"/><ellipse cx="600" cy="880" rx="340" ry="30" fill="#0f172a" opacity="0.16" filter="url(#soft)"/>${SHAPES[shape]!(color)}</svg>`,
    ),
  )
    .jpeg({ quality: 86, mozjpeg: true })
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
    const [color, word] = group.colors[Math.floor(i / 25) % group.colors.length]!;
    const round = Math.floor(i / (CATALOGUE.length * group.names.length * group.colors.length));
    const name = `${word} ${base}${round ? ` no. ${round + 1}` : ''}`;
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
    // Rows can share bytes: a handful of colours per shape is enough.
    const key = `${group.shape}:${color}`;
    if (!main.has(key)) {
      const bytes = await photo(group.shape, color);
      main.set(key, bytes);
      thumbs.set(key, await sharp(bytes).resize(320).jpeg({ quality: 78 }).toBuffer());
    }
    const fields = {
      mimeType: 'image/jpeg',
      storage: 'DATABASE' as const,
      data: new Uint8Array(main.get(key)!),
      thumbData: new Uint8Array(thumbs.get(key)!),
      sizeBytes: main.get(key)!.length,
      width: 1200,
      height: 1200,
    };
    await db.productImage.upsert({
      where: { productId: product.id },
      update: fields,
      create: { productId: product.id, ...fields },
      select: { id: true },
    });
  }
  // The three seeded products get the same treatment, so the shop has no empty tiles.
  for (const [sku, shape, color] of [
    ['KC-BASKET', 'basket', '#c6965a'],
    ['KC-WALLET', 'wallet', '#8a5a3a'],
    ['KC-COFFEE', 'pouch', '#2f4f3e'],
  ] as const) {
    const product = await db.product.findUnique({
      where: { merchantId_sku: { merchantId: DEMO_MERCHANT_ID, sku } },
    });
    if (!product) continue;
    const bytes = await photo(shape, color);
    const thumb = await sharp(bytes).resize(320).jpeg({ quality: 78 }).toBuffer();
    const fields = {
      mimeType: 'image/jpeg',
      storage: 'DATABASE' as const,
      data: new Uint8Array(bytes),
      thumbData: new Uint8Array(thumb),
      sizeBytes: bytes.length,
      width: 1200,
      height: 1200,
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
