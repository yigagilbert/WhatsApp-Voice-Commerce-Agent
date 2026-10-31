/**
 * Product management and photos (dashboard API) against a real Postgres: create/edit products,
 * stock counts through the ledger, photos stored in an R2-like object store (in-memory double)
 * or the database, replace/remove cleanup, merchant isolation, and photos for WhatsApp customers.
 *
 * The real R2 driver is unit-tested (signing, URLs) and was exercised against an S3-compatible
 * server (MinIO); see docs/deployment/cloudflare-r2.md.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import type { ObjectStore } from '../../apps/api/src/modules/images/object-store';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `img_shop_${run}`;
const otherShop = `img_other_${run}`;

/** In-memory stand-in for the R2 bucket; can be told to fail the next PUT. */
class MemoryStore implements ObjectStore {
  readonly kind = 'R2' as const;
  readonly objects = new Map<string, Buffer>();
  failPutAfter = Infinity;
  async put(key: string, body: Uint8Array) {
    if (this.failPutAfter-- <= 0) throw new Error('simulated R2 outage');
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const jpeg = (width = 1800, height = 1200, color = '#336699') =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

describe('product management and photos (integration)', () => {
  const store = new MemoryStore();
  let container: Container;
  let app: FastifyInstance;
  const headers = (merchant = shop) => ({
    authorization: 'Bearer test-dashboard-token-123456',
    'x-merchant-id': merchant,
  });
  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    merchant = shop,
  ) =>
    app.inject({
      method,
      url,
      headers: headers(merchant),
      ...(payload !== undefined ? { payload } : {}),
    });
  const upload = async (id: string, buf: Buffer, merchant = shop) =>
    api('PUT', `/api/products/${id}/image`, { dataBase64: buf.toString('base64') }, merchant);

  beforeAll(async () => {
    container = createContainer(
      parseConfig(apiSchema, testEnv()),
      createLogger({ name: 'it-img', level: 'silent' }),
      {
        paypal: new FakePayPal(`IMG-${run}`),
        chatModel: null,
        speech: null,
        channels: new ChannelRegistry(),
        objectStore: store,
      },
    );
    app = await buildApp(container);
    for (const [id, name] of [
      [shop, 'Image Shop'],
      [otherShop, 'Other Image Shop'],
    ] as const)
      await container.db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
  });

  afterAll(async () => {
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await app.close();
    await container.close();
  });

  let productId: string;

  describe('products', () => {
    it('creates a product with stock, alert level and visibility', async () => {
      const res = await api('POST', '/api/products', {
        name: 'Woven Tote',
        unitPrice: '18.50',
        stockQuantity: 25,
        reorderLevel: 5,
        visibleToCustomers: true,
        description: 'Raffia tote',
      });
      expect(res.statusCode).toBe(201);
      productId = res.json().id;
      expect(res.json()).toMatchObject({
        unitPriceMinor: 1850,
        stockQuantity: 25,
        reorderLevel: 5,
      });
      // Opening stock is in the ledger, as when a product is added by chat.
      const opening = await container.db.stockMovement.findFirstOrThrow({ where: { productId } });
      expect(opening).toMatchObject({ type: 'RESTOCK', quantity: 25, balanceAfter: 25 });
    });

    it('creates a product without a description (the editor sends null)', async () => {
      const res = await api('POST', '/api/products', {
        name: 'Sisal Coaster',
        unitPrice: '4',
        description: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ description: null, stockQuantity: null });
    });

    it('edits name, price and alert level, and records a stock count in the ledger', async () => {
      const res = await api('PATCH', `/api/products/${productId}`, {
        name: 'Woven Market Tote',
        unitPrice: '19',
        reorderLevel: 4,
        stockQuantity: 20,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Woven Market Tote',
        unitPriceMinor: 1900,
        reorderLevel: 4,
        stockQuantity: 20,
      });
      const movement = await container.db.stockMovement.findFirstOrThrow({
        where: { productId },
        orderBy: { createdAt: 'desc' },
      });
      expect(movement).toMatchObject({ type: 'ADJUSTMENT', quantity: -5, balanceAfter: 20 });
    });

    it('refuses a name that another product already uses', async () => {
      await api('POST', '/api/products', { name: 'Clay Pot', unitPrice: 5 });
      const res = await api('PATCH', `/api/products/${productId}`, { name: 'clay pot' });
      expect(res.statusCode).toBe(409);
    });

    it("can't edit another merchant's product", async () => {
      const res = await api('PATCH', `/api/products/${productId}`, { unitPrice: 1 }, otherShop);
      expect(res.statusCode).toBe(404);
      expect(
        (await api('GET', `/api/products/${productId}`, undefined, otherShop)).statusCode,
      ).toBe(404);
    });
  });

  describe('photos in object storage (R2)', () => {
    it('stores a resized main image and a thumbnail under the merchant’s prefix', async () => {
      const res = await upload(productId, await jpeg(2400, 1600));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ storage: 'R2', width: 1600, height: 1067 });
      const keys = [...store.objects.keys()];
      expect(keys).toHaveLength(2);
      expect(keys.every((k) => k.startsWith(`merchants/${shop}/products/${productId}/`))).toBe(
        true,
      );
      const row = await container.db.productImage.findUniqueOrThrow({ where: { productId } });
      expect(row).toMatchObject({ storage: 'R2', data: null, thumbData: null });
    });

    it('serves main and thumbnail with an ETag, and answers revalidation with 304', async () => {
      const thumb = await api('GET', `/api/products/${productId}/image?size=thumb`);
      expect(thumb.statusCode).toBe(200);
      expect((await sharp(thumb.rawPayload).metadata()).width).toBe(320);
      const etag = thumb.headers.etag as string;
      const again = await app.inject({
        method: 'GET',
        url: `/api/products/${productId}/image?size=thumb`,
        headers: { ...headers(), 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(304);
      const detail = await api('GET', `/api/products/${productId}`);
      expect(detail.json().image).toMatchObject({ storage: 'R2', width: 1600 });
    });

    it('replacing a photo removes the old objects', async () => {
      const before = [...store.objects.keys()];
      expect((await upload(productId, await jpeg(1000, 1000, '#aa3322'))).statusCode).toBe(200);
      const after = [...store.objects.keys()];
      expect(after).toHaveLength(2);
      expect(after.some((k) => before.includes(k))).toBe(false);
    });

    it('leaves the current photo intact and no orphan objects when the upload fails', async () => {
      const before = [...store.objects.keys()].sort();
      store.failPutAfter = 1; // main image succeeds, thumbnail fails
      const res = await upload(productId, await jpeg(900, 900, '#22aa55'));
      store.failPutAfter = Infinity;
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect([...store.objects.keys()].sort()).toEqual(before);
      expect((await api('GET', `/api/products/${productId}/image`)).statusCode).toBe(200);
    });

    it('rejects non-images and keeps other merchants out', async () => {
      const bad = await upload(productId, Buffer.from('GIF89a not really'));
      expect(bad.statusCode).toBe(400);
      expect((await upload(productId, await jpeg(), otherShop)).statusCode).toBe(404);
      expect(
        (await api('GET', `/api/products/${productId}/image`, undefined, otherShop)).statusCode,
      ).toBe(404);
      expect(
        (await api('DELETE', `/api/products/${productId}/image`, {}, otherShop)).statusCode,
      ).toBe(404);
      expect(store.objects.size).toBe(2);
    });

    it('sends the photo to WhatsApp customers only while the product is visible', async () => {
      const media = await container.customerCatalog.photo(shop, productId);
      expect(media).toMatchObject({ mimeType: 'image/jpeg', filename: 'product.jpg' });
      await api('PATCH', `/api/products/${productId}`, { visibleToCustomers: false });
      expect(await container.customerCatalog.photo(shop, productId)).toBeNull();
      await api('PATCH', `/api/products/${productId}`, { visibleToCustomers: true });
    });

    it('removing the photo deletes its objects', async () => {
      expect((await api('DELETE', `/api/products/${productId}/image`, {})).statusCode).toBe(204);
      expect(store.objects.size).toBe(0);
      expect((await api('GET', `/api/products/${productId}/image`)).statusCode).toBe(404);
      const events = await container.db.auditEvent.findMany({
        where: { entityId: productId, type: { startsWith: 'product.photo' } },
      });
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(['product.photo_updated', 'product.photo_removed']),
      );
    });
  });

  describe('photos in the database (no R2 configured)', () => {
    it('stores and serves main and thumbnail from Postgres', async () => {
      const dbOnly = createContainer(
        parseConfig(apiSchema, testEnv()),
        createLogger({ name: 'it-img-db', level: 'silent' }),
        {
          paypal: new FakePayPal(`IMGDB-${run}`),
          chatModel: null,
          speech: null,
          channels: new ChannelRegistry(),
          objectStore: null,
        },
      );
      try {
        const saved = await dbOnly.productImages.save(shop, productId, await jpeg(1200, 900));
        expect(saved).toMatchObject({ storage: 'DATABASE', width: 1200, height: 900 });
        const thumb = await dbOnly.productImages.read(shop, productId, 'thumb');
        expect((await sharp(thumb!.bytes).metadata()).width).toBe(320);
        expect(await dbOnly.productImages.read(otherShop, productId, 'main')).toBeNull();
      } finally {
        await dbOnly.close();
      }
    });
  });
});
