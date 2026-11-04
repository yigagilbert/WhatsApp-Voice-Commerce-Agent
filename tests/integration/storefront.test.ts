/**
 * The public storefront and its WhatsApp handoff, against a real Postgres with simulated PayPal.
 * The journey: browse → cart priced by the backend → reference → the customer's WhatsApp message →
 * delivery details → ORDER → PayPal → verified payment → stock. Plus what must never happen: leaked
 * internals, trusted client prices, reused or guessed references, cross-merchant access, overselling.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger, type ChannelSender, type OutboundChannelMessage } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import type { ObjectStore } from '../../apps/api/src/modules/images/object-store';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const digits = run.replace(/\D/g, '').padEnd(6, '4').slice(0, 6);
const shop = `sf_shop_${run}`;
const otherShop = `sf_other_${run}`;
const bigShop = `sf_big_${run}`;
const slug = `kampala-${run}`;
const otherSlug = `jinja-${run}`;
const bigSlug = `big-${run}`;
const bot = `25670${digits}1@c.us`;
const otherBot = `25670${digits}2@c.us`;
const admin = `25671${digits}1@c.us`;
const jane = `25678${digits}1@c.us`;
const bob = `25678${digits}2@c.us`;
const dashboard = { authorization: 'Bearer test-dashboard-token-123456', 'x-merchant-id': shop };

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

class MemoryStore implements ObjectStore {
  readonly kind = 'R2' as const;
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

interface Quote {
  lines: {
    productId: string;
    name: string | null;
    unit: string;
    lineTotal: string;
    listUnit: string | null;
    issue: string | null;
  }[];
  subtotal: string;
  savings: string | null;
  quote: string;
  ready: boolean;
  notice: string | null;
}

describe('public storefront (integration)', () => {
  const paypal = new FakePayPal(`SF-${run}`);
  const sender = new RecordingSender();
  const store = new MemoryStore();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;
  const ids: Record<string, string> = {};
  let otherProduct: string;

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const price = async (items: { productId: string; quantity: number }[], at = slug) =>
    (await post(`/api/public/shop/${at}/cart`, { items })).json() as Quote;
  const checkout = async (
    items: { productId: string; quantity: number }[],
    extra: { clientKey?: string; quote?: string; at?: string } = {},
  ) => {
    const at = extra.at ?? slug;
    const quote = extra.quote ?? (await price(items, at)).quote;
    const res = await post(`/api/public/shop/${at}/checkout`, {
      items,
      quote,
      ...(extra.clientKey ? { clientKey: extra.clientKey } : {}),
    });
    return res.json() as {
      status: string;
      reference: string;
      whatsappUrl: string;
      cart: Quote;
    };
  };
  const deliver = async (
    from: string,
    text: string,
    to = bot,
    messageId: string = randomUUID(),
  ) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: {
        channel: 'whatsapp',
        externalMessageId: messageId,
        externalChatId: from,
        senderId: from,
        sentAt: new Date(),
        type: 'text',
        text,
        recipientId: to,
      },
    });
    return res.json() as { status: string; replies: { text: string }[] };
  };
  const say = async (from: string, text: string, to = bot) =>
    (await deliver(from, text, to)).replies.map((r) => r.text).join('\n');
  const status = async (reference: string, at = slug) =>
    (
      (await post(`/api/public/shop/${at}/checkout/status`, { reference })).json() as {
        status: string;
      }
    ).status;
  const ordersOf = async (chat: string) => {
    const customer = await container.db.customer.findFirstOrThrow({
      where: { merchantId: shop, whatsappId: chat },
    });
    return container.db.order.findMany({
      where: { merchantId: shop, customerId: customer.id },
      include: { items: { orderBy: { position: 'asc' } }, payments: true },
      orderBy: { createdAt: 'asc' },
    });
  };
  const newShopper = (n: number) => `25678${digits.slice(0, 5)}${n}3@c.us`;

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    container = createContainer(
      parseConfig(
        apiSchema,
        testEnv({
          CUSTOMER_COMMERCE_ENABLED: 'true',
          CUSTOMER_MESSAGES_PER_MINUTE: '1000',
          WEB_PUBLIC_URL: 'https://kataleai.test',
          RATE_LIMIT_MAX: '100000',
        }),
      ),
      createLogger({ name: 'it-sf', level: 'silent' }),
      { paypal, chatModel: model, speech: null, channels, objectStore: store },
    );
    app = await buildApp(container);
    const db = container.db;
    for (const [id, name] of [
      [shop, 'Kampala Baskets'],
      [otherShop, 'Jinja Crafts'],
      [bigShop, 'Big Bazaar'],
    ] as const)
      await db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
    await db.merchant.update({
      where: { id: shop },
      data: { bundleMinItems: 2, bundlePercentOff: 5 },
    });
    await db.merchantOperator.create({
      data: { merchantId: shop, name: 'Owner', channel: 'whatsapp', externalId: admin },
    });
    for (const [merchantId, wid] of [
      [shop, bot],
      [otherShop, otherBot],
    ] as const) {
      const account = await container.whatsappAccounts.connect(merchantId, wid);
      await container.whatsappAccounts.update(
        merchantId,
        account.id,
        {
          customerCommerceEnabled: true,
          deliveryEnabled: true,
          deliveryFeeMinor: 500,
          pickupEnabled: false,
        },
        { customerCommerceAvailable: true },
      );
    }
    const product = async (
      key: string,
      data: {
        name: string;
        unitPriceMinor: number;
        stockQuantity?: number | null;
        category?: string;
        description?: string;
        visibleToCustomers?: boolean;
        active?: boolean;
        bargainingEnabled?: boolean;
        minPriceMinor?: number;
        quantityDiscounts?: { minQuantity: number; percentOff: number }[];
      },
    ) => {
      const created = await db.product.create({
        data: { merchantId: shop, currency: 'USD', sku: `${key}-${run}`, ...data },
      });
      ids[key] = created.id;
    };
    await product('basket', {
      name: 'Handmade Basket',
      description: 'Woven raffia basket for fruit',
      unitPriceMinor: 3000,
      stockQuantity: 6,
      category: 'Baskets',
      bargainingEnabled: true,
      minPriceMinor: 2400,
      quantityDiscounts: [{ minQuantity: 3, percentOff: 10 }],
    });
    await product('wallet', {
      name: 'Barkcloth Wallet',
      unitPriceMinor: 1800,
      stockQuantity: null,
      category: 'Leather and cloth',
    });
    await product('coffee', {
      name: 'Coffee Gift Pack',
      unitPriceMinor: 2500,
      stockQuantity: 10,
      category: 'Food',
    });
    await product('soldout', {
      name: 'Banana Fibre Mat',
      unitPriceMinor: 900,
      stockQuantity: 0,
      category: 'Baskets',
    });
    await product('hidden', {
      name: 'Secret Stock',
      unitPriceMinor: 100,
      stockQuantity: 5,
      visibleToCustomers: false,
    });
    await product('inactive', {
      name: 'Old Product',
      unitPriceMinor: 100,
      stockQuantity: 5,
      active: false,
    });
    otherProduct = (
      await db.product.create({
        data: {
          merchantId: otherShop,
          name: 'Jinja Drum',
          unitPriceMinor: 4000,
          currency: 'USD',
          stockQuantity: 10,
        },
      })
    ).id;
    await db.storefront.create({ data: { merchantId: otherShop, slug: otherSlug, enabled: true } });
    await db.storefront.create({ data: { merchantId: bigShop, slug: bigSlug, enabled: true } });
    await db.product.createMany({
      data: Array.from({ length: 1050 }, (_, i) => ({
        merchantId: bigShop,
        name: `Item ${String(i).padStart(4, '0')}${i % 50 === 0 ? ' kitenge' : ''}`,
        description: i % 7 === 0 ? 'Bright cotton fabric' : 'Plain',
        unitPriceMinor: 100 + i,
        currency: 'USD',
        stockQuantity: i % 10 === 0 ? 0 : 5,
        category: `Category ${i % 12}`,
      })),
    });
  }, 60_000);

  afterAll(async () => {
    await container.db.order.deleteMany({
      where: { merchantId: { in: [shop, otherShop, bigShop] } },
    });
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop, bigShop] } } });
    await app.close();
    await container.close();
  });

  describe('publishing', () => {
    it('stays private until the owner publishes', async () => {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/storefront',
        headers: dashboard,
        payload: { slug, enabled: false, tagline: 'Woven in Kampala', about: null },
      });
      expect(saved.statusCode).toBe(200);
      expect((await get(`/api/public/shop/${slug}`)).statusCode).toBe(404);
      expect((await get(`/api/public/shop/${slug}/products`)).statusCode).toBe(404);
      expect((await get('/api/public/shops')).body).not.toContain(slug);
    });

    it('lets only the owner preview an unpublished shop', async () => {
      const preview = await app.inject({
        method: 'GET',
        url: `/api/public/shop/${slug}`,
        headers: { 'x-storefront-preview': '1' },
      });
      expect(preview.statusCode).toBe(401);
    });

    it('refuses bad addresses and another shop’s address', async () => {
      const put = (value: string) =>
        app.inject({
          method: 'PUT',
          url: '/api/storefront',
          headers: dashboard,
          payload: { slug: value, enabled: true, tagline: null, about: null },
        });
      expect((await put('no spaces!')).statusCode).toBe(400);
      expect((await put(otherSlug)).statusCode).toBe(409);
    });

    it('publishes, and reports what checkout still needs', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/storefront',
        headers: dashboard,
        payload: { slug, enabled: true, tagline: 'Woven in Kampala', about: 'Family workshop' },
      });
      expect(res.statusCode).toBe(200);
      const settings = (
        await app.inject({ method: 'GET', url: '/api/storefront', headers: dashboard })
      ).json() as {
        enabled: boolean;
        checkoutBlocker: string | null;
        products: { shown: number; hidden: number };
      };
      expect(settings).toMatchObject({ enabled: true, checkoutBlocker: null });
      expect(settings.products).toMatchObject({ shown: 4, hidden: 1 });
    });
  });

  describe('dashboard product changes', () => {
    it('shows a new category and hides a product without any other step', async () => {
      const patch = (payload: object) =>
        app.inject({
          method: 'PATCH',
          url: `/api/products/${ids.wallet}`,
          headers: dashboard,
          payload,
        });
      expect((await patch({ category: '  Wallets  ' })).statusCode).toBe(200);
      const wallets = (await get(`/api/public/shop/${slug}/products?category=wallets`)).json() as {
        total: number;
      };
      expect(wallets.total).toBe(1);
      expect(
        (await patch({ category: 'Leather and cloth', visibleToCustomers: false })).statusCode,
      ).toBe(200);
      expect((await get(`/api/public/shop/${slug}/products/${ids.wallet}`)).statusCode).toBe(404);
      await patch({ visibleToCustomers: true });
    });
  });

  describe('catalogue', () => {
    it('shows only active, visible products and never internal fields', async () => {
      const res = await get(`/api/public/shop/${slug}/products`);
      const body = res.json() as { products: { name: string; availability: string }[] };
      expect(body.products.map((p) => p.name)).toEqual([
        'Banana Fibre Mat',
        'Barkcloth Wallet',
        'Coffee Gift Pack',
        'Handmade Basket',
      ]);
      for (const leak of ['stockQuantity', 'minPriceMinor', 'sku', 'reorderLevel', 'merchantId'])
        expect(res.body).not.toContain(leak);
      expect(body.products[0]!.availability).toBe('Out of stock');
      const shopInfo = (await get(`/api/public/shop/${slug}`)).json() as {
        name: string;
        checkoutAvailable: boolean;
        categories: { name: string; count: number }[];
      };
      expect(shopInfo).toMatchObject({ name: 'Kampala Baskets', checkoutAvailable: true });
      expect(shopInfo.categories).toContainEqual({ name: 'Baskets', count: 2 });
      expect((await get(`/api/public/shop/${slug}/products/${ids.hidden}`)).statusCode).toBe(404);
      expect((await get(`/api/public/shop/${slug}/products/${otherProduct}`)).statusCode).toBe(404);
    });

    it('searches names and descriptions, singular or plural, in any case', async () => {
      const names = async (q: string) =>
        (
          (await get(`/api/public/shop/${slug}/products?q=${encodeURIComponent(q)}`)).json() as {
            products: { name: string }[];
          }
        ).products.map((p) => p.name);
      expect(await names('BASKETS')).toEqual(['Banana Fibre Mat', 'Handmade Basket']);
      expect(await names('raffia fruit')).toEqual(['Handmade Basket']);
      expect(await names('nothing like this')).toEqual([]);
      // Punctuation alone is no filter, never a wildcard.
      expect(await names('%')).toHaveLength(4);
    });

    it('sorts, filters by category and hides sold-out products on request', async () => {
      const prices = (
        (await get(`/api/public/shop/${slug}/products?sort=price_desc`)).json() as {
          products: { priceMinor: number }[];
        }
      ).products.map((p) => p.priceMinor);
      expect(prices).toEqual([3000, 2500, 1800, 900]);
      const inStock = (await get(`/api/public/shop/${slug}/products?inStock=1`)).body;
      expect(inStock).not.toContain('Banana');
      const baskets = (await get(`/api/public/shop/${slug}/products?category=baskets`)).json() as {
        total: number;
      };
      expect(baskets.total).toBe(2);
    });

    it.each([10, 100, 500])('pages through a shop with %i products', async (size) => {
      const id = `sf_size_${size}_${run}`;
      const sizedSlug = `size-${size}-${run}`;
      await container.db.merchant.create({
        data: { id, businessName: `Shop of ${size}`, ownerName: 'Owner' },
      });
      await container.db.storefront.create({
        data: { merchantId: id, slug: sizedSlug, enabled: true },
      });
      await container.db.product.createMany({
        data: Array.from({ length: size }, (_, i) => ({
          merchantId: id,
          name: `Product ${i}`,
          unitPriceMinor: 100 + i,
          currency: 'USD',
          category: `Category ${i % 4}`,
        })),
      });
      const seen = new Set<string>();
      let timing = 0;
      for (let page = 1; ; page++) {
        const started = performance.now();
        const res = await get(`/api/public/shop/${sizedSlug}/products?page=${page}`);
        timing = Math.max(timing, performance.now() - started);
        const body = res.json() as { products: { id: string }[]; pages: number; total: number };
        expect(body.total).toBe(size);
        for (const p of body.products) seen.add(p.id);
        if (page >= body.pages) break;
      }
      expect(seen.size).toBe(size);
      expect(timing).toBeLessThan(1000);
      await container.db.merchant.delete({ where: { id } });
    });

    it('serves every page of 1,050 products exactly once, quickly', async () => {
      const seen = new Set<string>();
      const timings: number[] = [];
      for (let page = 1; page <= 22; page++) {
        const started = performance.now();
        const res = await get(`/api/public/shop/${bigSlug}/products?page=${page}&pageSize=48`);
        timings.push(performance.now() - started);
        for (const p of (res.json() as { products: { id: string }[] }).products) seen.add(p.id);
      }
      expect(seen.size).toBe(1050);
      expect(Math.max(...timings)).toBeLessThan(1000);
      const search = (await get(`/api/public/shop/${bigSlug}/products?q=kitenge`)).json() as {
        total: number;
      };
      expect(search.total).toBe(21);
      const shop = (await get(`/api/public/shop/${bigSlug}`)).json() as {
        totalProducts: number;
        categories: unknown[];
      };
      expect(shop).toMatchObject({ totalProducts: 1050 });
      expect(shop.categories).toHaveLength(12);
      // A sold-out filter over a big shop stays exact.
      const available = (await get(`/api/public/shop/${bigSlug}/products?inStock=1`)).json() as {
        total: number;
      };
      expect(available.total).toBe(945);
    });

    it('clamps a page past the end instead of failing', async () => {
      const res = (
        await get(`/api/public/shop/${bigSlug}/products?page=9999&pageSize=48`)
      ).json() as {
        page: number;
        products: unknown[];
      };
      expect(res.page).toBe(22);
      expect(res.products.length).toBeGreaterThan(0);
    });
  });

  describe('images', () => {
    it('serves published photos from the object store with long caching, and nothing else', async () => {
      const png = await sharp({
        create: { width: 400, height: 400, channels: 3, background: '#0a8a3a' },
      })
        .png()
        .toBuffer();
      await container.productImages.save(shop, ids.basket!, png);
      await container.productImages.save(shop, ids.hidden!, png);
      expect(store.objects.size).toBe(4);
      const { imageVersion } = (
        await get(`/api/public/shop/${slug}/products/${ids.basket}`)
      ).json() as { imageVersion: string };
      const res = await get(
        `/api/public/shop/${slug}/products/${ids.basket}/image?size=thumb&v=${imageVersion}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toContain('immutable');
      const card = await get(
        `/api/public/shop/${slug}/products/${ids.basket}/image?size=card&v=${imageVersion}`,
      );
      expect((await sharp(card.rawPayload).metadata()).width).toBe(640);
      expect((await get(`/api/public/shop/${slug}/products/${ids.hidden}/image`)).statusCode).toBe(
        404,
      );
      expect(
        (await get(`/api/public/shop/${otherSlug}/products/${ids.basket}/image`)).statusCode,
      ).toBe(404);
    });

    it('stores a logo through the same checks', async () => {
      const png = await sharp({
        create: { width: 200, height: 200, channels: 3, background: '#111111' },
      })
        .png()
        .toBuffer();
      const put = await app.inject({
        method: 'PUT',
        url: '/api/storefront/logo',
        headers: dashboard,
        payload: { dataBase64: png.toString('base64') },
      });
      expect(put.statusCode).toBe(200);
      const logo = await get(`/api/public/shop/${slug}/logo`);
      expect(logo.statusCode).toBe(200);
      expect(logo.headers['content-type']).toBe('image/jpeg');
      const bad = await app.inject({
        method: 'PUT',
        url: '/api/storefront/logo',
        headers: dashboard,
        payload: { dataBase64: Buffer.from('not an image').toString('base64') },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('cart pricing', () => {
    it('prices on the server with quantity and bundle discounts, ignoring anything the client sends', async () => {
      const single = await price([{ productId: ids.basket!, quantity: 1 }]);
      expect(single.lines[0]).toMatchObject({
        unit: '$30.00',
        lineTotal: '$30.00',
        listUnit: null,
      });
      const bulk = await price([{ productId: ids.basket!, quantity: 3 }]);
      expect(bulk.lines[0]).toMatchObject({
        unit: '$27.00',
        lineTotal: '$81.00',
        listUnit: '$30.00',
      });
      expect(bulk.savings).toBe('$9.00');
      const forged = await post(`/api/public/shop/${slug}/cart`, {
        items: [{ productId: ids.basket!, quantity: 1, unitPriceMinor: 1 }],
      });
      expect((forged.json() as Quote).subtotal).toBe('$30.00');
    });

    it('flags problem lines without revealing stock counts, and blocks checkout', async () => {
      const cart = await price([
        { productId: ids.soldout!, quantity: 1 },
        { productId: ids.basket!, quantity: 7 },
        { productId: ids.hidden!, quantity: 1 },
        { productId: otherProduct, quantity: 1 },
        { productId: ids.coffee!, quantity: 21 },
      ]);
      expect(cart.lines.map((l) => l.issue)).toEqual([
        'out_of_stock',
        'insufficient',
        'unavailable',
        'unavailable',
        'limit',
      ]);
      expect(cart.ready).toBe(false);
      expect(JSON.stringify(cart)).not.toContain('Secret Stock');
      expect(JSON.stringify(cart)).not.toContain('Jinja Drum');
      expect(JSON.stringify(cart)).not.toMatch(/\b6 (left|in stock)\b/);
      expect((await price([])).ready).toBe(false);
    });

    it('rejects malformed carts', async () => {
      const bad = async (items: object | string) =>
        (await post(`/api/public/shop/${slug}/cart`, { items })).statusCode;
      expect(await bad([{ productId: ids.basket, quantity: 0 }])).toBe(400);
      expect(await bad([{ productId: ids.basket, quantity: 1.5 }])).toBe(400);
      expect(await bad('x')).toBe(400);
    });
  });

  describe('WhatsApp handoff', () => {
    it('builds a link to the merchant’s own number holding only an opaque reference', async () => {
      const items = [{ productId: ids.basket!, quantity: 2 }];
      const result = await checkout(items);
      expect(result.status).toBe('ready');
      const url = new URL(result.whatsappUrl);
      expect(url.origin + url.pathname).toBe(`https://wa.me/${bot.split('@')[0]}`);
      const text = url.searchParams.get('text')!;
      expect(text).toContain(result.reference);
      expect(text).toContain('Kampala Baskets');
      expect(text).not.toMatch(/\$|30\.00|Handmade|quantity/i);
      expect(result.reference).toMatch(/^KC-[A-Z2-7]{24}$/);
      // Only the hash is stored.
      const rows = await container.db.cartTransfer.findMany({ where: { merchantId: shop } });
      expect(JSON.stringify(rows)).not.toContain(result.reference);
      expect(await status(result.reference)).toBe('waiting');
    });

    it('refuses a stale quote and an invalid cart', async () => {
      const items = [{ productId: ids.wallet!, quantity: 1 }];
      const stale = await checkout(items, { quote: 'old-quote' });
      expect(stale.status).toBe('changed');
      expect(stale.cart.ready).toBe(true);
      const invalid = await checkout([{ productId: ids.soldout!, quantity: 1 }]);
      expect(invalid.status).toBe('invalid');
    });

    it('offers no checkout while customer shopping is off for the number', async () => {
      const account = await container.db.whatsAppAccount.findFirstOrThrow({
        where: { merchantId: shop },
      });
      await container.db.whatsAppAccount.update({
        where: { id: account.id },
        data: { customerCommerceEnabled: false },
      });
      expect((await checkout([{ productId: ids.wallet!, quantity: 1 }])).status).toBe(
        'unavailable',
      );
      await container.db.whatsAppAccount.update({
        where: { id: account.id },
        data: { customerCommerceEnabled: true },
      });
    });

    it('completes the whole journey: reference → details → ORDER → PayPal → paid → stock', async () => {
      const before = (await container.db.product.findUniqueOrThrow({ where: { id: ids.basket! } }))
        .stockQuantity!;
      const items = [
        { productId: ids.basket!, quantity: 2 },
        { productId: ids.wallet!, quantity: 1 },
      ];
      const { reference, whatsappUrl } = await checkout(items, {
        clientKey: `key-${run}-journey-1`,
      });
      const text = new URL(whatsappUrl).searchParams.get('text')!;

      // Opening the link is not a checkout: nothing exists until the message arrives.
      expect(await status(reference)).toBe('waiting');
      expect(await container.db.customer.count({ where: { whatsappId: jane } })).toBe(0);

      const first = await say(jane, text);
      expect(first).toContain('Got your cart from our website');
      expect(first).toContain('Handmade Basket × 2');
      expect(first).toContain('Barkcloth Wallet × 1');
      expect(first).toContain('What name should we put on your order?');
      expect(await status(reference)).toBe('received');

      const [cart] = await ordersOf(jane);
      expect(cart).toMatchObject({ status: 'DRAFT', source: 'storefront', placedBy: 'CUSTOMER' });

      expect(await say(jane, 'Jane Achieng')).toContain('Where should we deliver?');
      const summary = await say(jane, 'Plot 5, Kampala Road, near the mosque');
      expect(summary).toContain('Delivery: $5.00');
      expect(summary).toContain('Reply *ORDER*');
      expect(paypal.created).toHaveLength(0);

      const placed = await say(jane, 'ORDER');
      expect(placed).toContain('https://www.sandbox.paypal.com/checkoutnow?token=');
      // 2 baskets at 5% bundle discount ($28.50) + a wallet at its regular fixed price.
      const [order] = await ordersOf(jane);
      expect(order).toMatchObject({ status: 'AWAITING_PAYMENT', shippingMinor: 500 });
      expect(order!.items.map((i) => [i.description, i.quantity])).toEqual([
        ['Handmade Basket', 2],
        ['Barkcloth Wallet', 1],
      ]);
      expect(paypal.created).toHaveLength(1);

      // A repeated reference after the order changes nothing.
      expect(await say(jane, text)).toContain("You've already sent me that cart");
      expect(await ordersOf(jane)).toHaveLength(1);
      expect(paypal.created).toHaveLength(1);

      const token = order!.payments[0]!.externalId!;
      await app.inject({ method: 'GET', url: `/api/paypal/return?token=${token}` });
      const paid = await container.db.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(paid.status).toBe('PAID');
      const after = await container.db.product.findUniqueOrThrow({ where: { id: ids.basket! } });
      expect(after.stockQuantity).toBe(before - 2);
    });

    it('ignores a duplicate delivery of the same WhatsApp message', async () => {
      const shopper = newShopper(1);
      const { whatsappUrl } = await checkout([{ productId: ids.wallet!, quantity: 2 }]);
      const text = new URL(whatsappUrl).searchParams.get('text')!;
      const messageId = randomUUID();
      await deliver(shopper, text, bot, messageId);
      const duplicate = await deliver(shopper, text, bot, messageId);
      expect(duplicate.status).toBe('duplicate');
      const [cart] = await ordersOf(shopper);
      expect(cart!.items[0]!.quantity).toBe(2);
    });

    it('gives a raced reference to exactly one customer', async () => {
      const { reference } = await checkout([{ productId: ids.wallet!, quantity: 1 }]);
      const replies = await Promise.all([
        say(newShopper(2), `ref ${reference}`),
        say(newShopper(3), `ref ${reference}`),
      ]);
      expect(replies.filter((r) => r.includes('Got your cart'))).toHaveLength(1);
      expect(replies.filter((r) => r.includes('already been used'))).toHaveLength(1);
    });

    it('never shows one customer another customer’s cart', async () => {
      const { reference } = await checkout([{ productId: ids.coffee!, quantity: 1 }]);
      await say(newShopper(4), reference);
      const stolen = await say(bob, reference);
      expect(stolen).toContain('already been used');
      expect(stolen).not.toContain('Coffee');
      expect(
        await container.db.customer.count({ where: { whatsappId: bob, orders: { some: {} } } }),
      ).toBe(0);
    });

    it('binds a reference to its merchant', async () => {
      const { reference } = await checkout([{ productId: ids.coffee!, quantity: 1 }]);
      const elsewhere = await say(newShopper(5), reference, otherBot);
      expect(elsewhere).toContain("I couldn't find that cart");
      expect(await status(reference, otherSlug)).toBe('expired');
      // It still works at the right shop.
      expect(await status(reference)).toBe('waiting');
    });

    it('turns away guessed, expired and replaced references', async () => {
      const shopper = newShopper(6);
      expect(await say(shopper, 'KC-AAAAAAAAAAAAAAAAAAAAAAAA')).toContain(
        "I couldn't find that cart",
      );

      const expired = await checkout([{ productId: ids.coffee!, quantity: 1 }]);
      await container.db.cartTransfer.updateMany({
        where: { merchantId: shop, status: 'OPEN' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await say(shopper, expired.reference)).toContain('expired');
      expect(await status(expired.reference)).toBe('expired');

      const clientKey = `key-${run}-replace-1`;
      const older = await checkout([{ productId: ids.coffee!, quantity: 1 }], { clientKey });
      const newer = await checkout([{ productId: ids.coffee!, quantity: 2 }], { clientKey });
      expect(await say(shopper, older.reference)).toContain('replaced by a newer one');
      expect(await say(shopper, newer.reference)).toContain('Coffee Gift Pack × 2');
    });

    it('revalidates stock and price when the message arrives, not when the link was made', async () => {
      const shopper = newShopper(7);
      await container.db.product.update({
        where: { id: ids.coffee! },
        data: { stockQuantity: 50 },
      });
      const { reference } = await checkout([
        { productId: ids.coffee!, quantity: 1 },
        { productId: ids.wallet!, quantity: 1 },
        { productId: ids.basket!, quantity: 1 },
      ]);
      await container.db.product.update({ where: { id: ids.coffee! }, data: { stockQuantity: 0 } });
      await container.db.product.update({
        where: { id: ids.wallet! },
        data: { unitPriceMinor: 2000 },
      });
      await container.db.product.update({
        where: { id: ids.basket! },
        data: { visibleToCustomers: false },
      });
      const reply = await say(shopper, reference);
      expect(reply).toContain('Coffee Gift Pack just sold out');
      expect(reply).toContain('Handmade Basket is no longer available');
      expect(reply).toContain('Barkcloth Wallet is now $20.00 each');
      const [cart] = await ordersOf(shopper);
      expect(cart!.items.map((i) => i.description)).toEqual(['Barkcloth Wallet']);
      expect(cart!.items[0]!.unitPriceMinor).toBe(2000);
      await container.db.product.update({
        where: { id: ids.coffee! },
        data: { stockQuantity: 50 },
      });
      await container.db.product.update({
        where: { id: ids.wallet! },
        data: { unitPriceMinor: 1800 },
      });
      await container.db.product.update({
        where: { id: ids.basket! },
        data: { visibleToCustomers: true },
      });
    });

    it('says so plainly when nothing in the cart can be ordered', async () => {
      const shopper = newShopper(8);
      await container.db.product.update({ where: { id: ids.coffee! }, data: { stockQuantity: 5 } });
      const { reference } = await checkout([{ productId: ids.coffee!, quantity: 1 }]);
      await container.db.product.update({ where: { id: ids.coffee! }, data: { stockQuantity: 0 } });
      const reply = await say(shopper, reference);
      expect(reply).toContain('nothing was added');
      expect(reply).toContain(`https://kataleai.test/shop/${slug}`);
      await container.db.product.update({
        where: { id: ids.coffee! },
        data: { stockQuantity: 50 },
      });
    });

    it('merges into an existing WhatsApp cart', async () => {
      const shopper = newShopper(9);
      await say(shopper, 'hi');
      const list = await say(shopper, '1');
      expect(list).toContain('Barkcloth Wallet');
      await say(shopper, 'add 1 of 2');
      const { reference } = await checkout([{ productId: ids.coffee!, quantity: 2 }]);
      const reply = await say(shopper, reference);
      expect(reply).toContain('Barkcloth Wallet × 1');
      expect(reply).toContain('Coffee Gift Pack × 2');
      expect(await ordersOf(shopper)).toHaveLength(1);
    });

    it('keeps bargaining available after the handoff, with prices from the backend', async () => {
      const shopper = `25677${digits.slice(0, 4)}996@c.us`;
      const { reference } = await checkout([{ productId: ids.basket!, quantity: 1 }]);
      expect(await say(shopper, reference)).toContain('Handmade Basket × 1');
      const customer = await container.db.customer.findFirstOrThrow({
        where: { merchantId: shop, whatsappId: shopper },
      });
      const [cart] = await ordersOf(shopper);
      const offer = await container.bargaining.ask(
        {
          merchant: { id: shop, businessName: 'Kampala Baskets' },
          customer,
          conversationId: cart!.conversationId!,
        },
        ids.basket!,
        { quantity: null, customerUnitMinor: 2500, customerTotalMinor: null },
      );
      expect(offer.status).not.toBe('fixed_price');
      expect(offer.message).not.toContain('$24.00');
      const accepted = await say(shopper, 'deal');
      expect(accepted).toContain('Handmade Basket');
      const [after] = await ordersOf(shopper);
      expect(after!.items[0]!.pricing).toBe('NEGOTIATED');
      expect(after!.items[0]!.unitPriceMinor).toBeGreaterThanOrEqual(2400);
      expect(after!.items[0]!.unitPriceMinor).toBeLessThan(3000);
    });

    it('still accepts a reference when the customer has too many unpaid orders, once they pay', async () => {
      const shopper = `25677${digits.slice(0, 4)}991@c.us`;
      await say(shopper, 'hi');
      const customer = await container.db.customer.findFirstOrThrow({
        where: { merchantId: shop, whatsappId: shopper },
      });
      const blocking = await Promise.all(
        [0, 1, 2].map((n) =>
          container.db.order.create({
            data: {
              reference: `SF${digits}${n}`.slice(0, 16),
              merchantId: shop,
              customerId: customer.id,
              status: 'AWAITING_PAYMENT',
              placedBy: 'CUSTOMER',
              currency: 'USD',
              subtotalMinor: 100,
              totalMinor: 100,
              source: 'whatsapp',
            },
          }),
        ),
      );
      const { reference } = await checkout([{ productId: ids.wallet!, quantity: 1 }]);
      expect(await say(shopper, reference)).toContain('3 unpaid orders');
      expect(await status(reference)).toBe('waiting');
      await container.db.order.update({
        where: { id: blocking[0]!.id },
        data: { status: 'CANCELLED' },
      });
      expect(await say(shopper, reference)).toContain('Got your cart');
    });

    it('resumes automated replies when a paused customer sends a cart', async () => {
      const shopper = `25677${digits.slice(0, 4)}992@c.us`;
      expect(await say(shopper, 'I want to talk to a real person')).toContain('let the team know');
      expect(await say(shopper, 'still there?')).toBe('');
      const { reference } = await checkout([{ productId: ids.wallet!, quantity: 1 }]);
      expect(await say(shopper, reference)).toContain('Got your cart');
      expect(sender.sent.at(-1)!.text).toContain('automated replies are back on');
    });

    it('tells an admin number to test from another phone', async () => {
      const { reference } = await checkout([{ productId: ids.wallet!, quantity: 1 }]);
      expect(await say(admin, reference)).toContain("isn't an admin");
      expect(await status(reference)).toBe('waiting');
    });

    it('deletes old references on the sweep', async () => {
      const removed = await container.storefront.purgeTransfers(
        new Date(Date.now() + 30 * 24 * 3_600_000),
      );
      expect(removed).toBeGreaterThan(0);
    });
  });

  describe('WhatsApp assistant', () => {
    it('suggests the catalogue when asked for everything, without an AI call', async () => {
      const shopper = `25677${digits.slice(0, 4)}993@c.us`;
      for (const ask of [
        'Show me all your products.',
        'see the catalogue',
        'website',
        'can you send me all your products please',
      ]) {
        const reply = await say(shopper, ask);
        expect(reply).toContain(`https://kataleai.test/shop/${slug}`);
      }
      expect(model.requests).toHaveLength(0);
    });

    it('adds the link to the menu, and keeps the WhatsApp-only flow working', async () => {
      const shopper = `25677${digits.slice(0, 4)}994@c.us`;
      const menu = await say(shopper, 'hi');
      expect(menu).toContain('*1* Browse products');
      expect(menu).toContain(`https://kataleai.test/shop/${slug}`);
      expect(await say(shopper, '1')).toContain('1. Banana Fibre Mat');
      expect(await say(shopper, 'add 1 of 2')).toContain('Barkcloth Wallet');
      expect(await say(shopper, 'checkout')).toContain('What name');
    });

    it('sends no links for an unpublished shop', async () => {
      await container.db.storefront.update({
        where: { merchantId: shop },
        data: { enabled: false },
      });
      const shopper = `25677${digits.slice(0, 4)}995@c.us`;
      expect(await say(shopper, 'hi')).not.toContain('kataleai.test');
      await container.db.storefront.update({
        where: { merchantId: shop },
        data: { enabled: true },
      });
    });

    it('builds product and category links in the backend', async () => {
      const service = container.storefront;
      expect(await service.link(shop, { productId: ids.basket! })).toBe(
        `https://kataleai.test/shop/${slug}/p/${ids.basket}`,
      );
      expect(await service.link(shop, { category: 'Leather and cloth' })).toBe(
        `https://kataleai.test/shop/${slug}?category=Leather%20and%20cloth`,
      );
    });
  });
});
