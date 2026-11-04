import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NotFoundError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { authenticate } from '../../http/auth';
import {
  DASHBOARD_SESSION_HEADER,
  DASHBOARD_USER_HEADER,
  actorLabel,
  ownerOnly,
} from '../../http/merchant-scope';
import { parse } from '../../http/validation';
import { cardVariant } from '../images/image-processing';

const PREVIEW_HEADER = 'x-storefront-preview';

const slugParams = z.object({ slug: z.string().min(1).max(64) });
const productParams = slugParams.extend({ id: z.string().min(1).max(64) });
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  sort: z.enum(['name', 'price_asc', 'price_desc', 'newest']).optional(),
  inStock: z.enum(['1', 'true']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(48).optional(),
});
const imageQuery = z.object({
  size: z.enum(['main', 'card', 'thumb']).optional(),
  v: z.string().max(80).optional(),
});
const cartItems = z
  .array(
    z.object({
      productId: z.string().min(1).max(64),
      // Larger than any order may hold, so the customer sees the shop's limit message.
      quantity: z.number().int().min(1).max(1000),
    }),
  )
  .max(60);
const cartBody = z.object({ items: cartItems });
const checkoutBody = z.object({
  items: cartItems.min(1),
  quote: z.string().min(1).max(64),
  clientKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .optional(),
});
const statusBody = z.object({ reference: z.string().regex(/^KC-[A-Za-z2-7]{24}$/) });

/** Resized grid photos kept in memory (about 60 KB each), so a busy page isn't resized twice. */
const CARD_CACHE_ENTRIES = 300;
const cards = new Map<string, Buffer>();

const IMAGE_RATE = { rateLimit: { max: 1200, timeWindow: '1 minute' } };
const CHECKOUT_RATE = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/**
 * The public storefront API. Unauthenticated, read-only apart from creating a short-lived cart
 * reference, and shaped so nothing internal can leak: products go through StorefrontService.view
 * (no stock counts, SKUs or minimum prices), and unpublished shops answer 404.
 */
export async function storefrontPublicRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const { storefront } = container;

  /**
   * An owner's preview of their own unpublished shop: only the dashboard server can ask (it holds
   * the service token), on behalf of a signed-in account, and only for that account's merchant.
   */
  const previewMerchant = async (request: FastifyRequest): Promise<string | null> => {
    if (request.headers[PREVIEW_HEADER] !== '1') return null;
    authenticate(
      request,
      {
        dashboard: container.config.API_AUTH_TOKEN,
        internal: container.config.INTERNAL_SERVICE_TOKEN,
      },
      ['dashboard'],
    );
    const userId = request.headers[DASHBOARD_USER_HEADER];
    if (typeof userId === 'string') {
      const version = Number(request.headers[DASHBOARD_SESSION_HEADER]);
      const user = Number.isInteger(version)
        ? await container.dashboardUsers.session(userId, version)
        : null;
      return user?.merchantId ?? null;
    }
    if ((await container.dashboardUsers.count()) > 0) return null;
    return (await container.db.merchant.findFirst({ orderBy: { createdAt: 'asc' } }))?.id ?? null;
  };

  const cacheable = (seconds: number) => `public, max-age=${seconds}`;

  app.get('/api/public/shops', async (_request, reply) => {
    reply.header('Cache-Control', cacheable(60));
    return { shops: await storefront.publishedShops() };
  });

  app.get('/api/public/shop/:slug', async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const shop = await storefront.publicShop(slug, await previewMerchant(request));
    reply.header('Cache-Control', shop.preview ? 'no-store' : cacheable(30));
    return shop;
  });

  app.get('/api/public/shop/:slug/products', async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const { inStock, ...query } = parse(listQuery, request.query);
    const merchantId = await storefront.merchantIdOf(slug, await previewMerchant(request));
    reply.header('Cache-Control', cacheable(15));
    return storefront.listProducts(merchantId, { ...query, inStock: !!inStock });
  });

  app.get('/api/public/shop/:slug/product-ids', async (request) => {
    const { slug } = parse(slugParams, request.params);
    return { products: await storefront.productIds(slug) };
  });

  app.get('/api/public/shop/:slug/products/:id', async (request, reply) => {
    const { slug, id } = parse(productParams, request.params);
    const merchantId = await storefront.merchantIdOf(slug, await previewMerchant(request));
    reply.header('Cache-Control', cacheable(15));
    return storefront.product(merchantId, id);
  });

  /** Photos stay in the private R2 bucket; this serves only products the public may see. */
  app.get(
    '/api/public/shop/:slug/products/:id/image',
    { config: IMAGE_RATE },
    async (request, reply) => {
      const { slug, id } = parse(productParams, request.params);
      const { size, v } = parse(imageQuery, request.query);
      const merchantId = await storefront.merchantIdOf(slug, await previewMerchant(request));
      await storefront.product(merchantId, id);
      const image = await container.productImages.read(
        merchantId,
        id,
        size === 'thumb' ? 'thumb' : 'main',
      );
      if (!image) throw new NotFoundError('Photo', id);
      const etag = `"${image.version}-${size ?? 'main'}"`;
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      let bytes = image.bytes;
      if (size === 'card') {
        const key = `${id}:${image.version}`;
        bytes = cards.get(key) ?? (await cardVariant(image.bytes));
        cards.set(key, bytes);
        if (cards.size > CARD_CACHE_ENTRIES) cards.delete(cards.keys().next().value!);
      }
      return reply
        .header('content-type', image.mimeType)
        .header('etag', etag)
        .header(
          'cache-control',
          v === image.version ? 'public, max-age=31536000, immutable' : cacheable(300),
        )
        .send(bytes);
    },
  );

  app.get('/api/public/shop/:slug/logo', { config: IMAGE_RATE }, async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const { v } = parse(imageQuery, request.query);
    const logo = await storefront.readLogo(slug, await previewMerchant(request));
    if (!logo) throw new NotFoundError('Logo', slug);
    return reply
      .header('content-type', logo.mimeType)
      .header(
        'cache-control',
        v === logo.version ? 'public, max-age=31536000, immutable' : cacheable(300),
      )
      .send(logo.bytes);
  });

  app.post('/api/public/shop/:slug/cart', async (request) => {
    const { slug } = parse(slugParams, request.params);
    const { items } = parse(cartBody, request.body);
    return storefront.priceCart(await storefront.merchantIdOf(slug), items);
  });

  app.post('/api/public/shop/:slug/checkout', { config: CHECKOUT_RATE }, async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const body = parse(checkoutBody, request.body);
    reply.header('Cache-Control', 'no-store');
    return storefront.checkout(slug, body);
  });

  /** A POST so the reference never appears in access logs. */
  app.post('/api/public/shop/:slug/checkout/status', async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const { reference } = parse(statusBody, request.body);
    reply.header('Cache-Control', 'no-store');
    return { status: await storefront.transferStatus(slug, reference) };
  });
}

const settingsBody = z.object({
  slug: z.string().trim().toLowerCase().min(3).max(60),
  enabled: z.boolean(),
  tagline: z.string().max(120).nullable(),
  about: z.string().max(600).nullable(),
});

/** Dashboard: the merchant's own storefront settings. */
export async function storefrontDashboardRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const { storefront } = container;
  const maxUpload = container.config.IMAGE_MAX_UPLOAD_BYTES;
  const logoBody = z.object({
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((maxUpload * 4) / 3) + 8),
  });

  app.get('/api/storefront', async (request) => storefront.settings(request.merchant));

  app.put('/api/storefront', { preHandler: ownerOnly }, async (request) =>
    storefront.save(request.merchant.id, parse(settingsBody, request.body), actorLabel(request)),
  );

  app.put(
    '/api/storefront/logo',
    { preHandler: ownerOnly, bodyLimit: Math.ceil(maxUpload * 1.4) + 64 * 1024 },
    async (request) => {
      const body = parse(logoBody, request.body);
      await storefront.saveLogo(
        request.merchant,
        Buffer.from(body.dataBase64, 'base64'),
        actorLabel(request),
      );
      return { ok: true };
    },
  );

  app.delete('/api/storefront/logo', { preHandler: ownerOnly }, async (request, reply) => {
    await storefront.removeLogo(request.merchant.id);
    return reply.status(204).send();
  });
}
