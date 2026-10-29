import type { FastifyInstance } from 'fastify';
import { toMajorString, toMinorUnits } from '@vca/commerce';
import { HEADERS, NotFoundError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { actorLabel, ownerOnly } from '../../http/merchant-scope';
import { parse } from '../../http/validation';

const idParams = z.object({ id: z.string().min(1).max(64) });
const productPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibleToCustomers: z.boolean().optional(),
  active: z.boolean().optional(),
  /** Major units, e.g. 12 or "12.50", in the product's currency. */
  unitPrice: z.union([z.number().positive(), z.string().min(1)]).optional(),
  reorderLevel: z.number().int().min(0).max(1_000_000).nullable().optional(),
  sku: z.string().trim().max(64).nullable().optional(),
  /** A counted stock level; recorded in the stock ledger as a dashboard count. */
  stockQuantity: z.number().int().min(0).max(1_000_000).optional(),
});
const imageQuery = z.object({ size: z.enum(['main', 'thumb']).optional() });
const accountPatch = z.object({
  customerCommerceEnabled: z.boolean().optional(),
  paymentLinkMode: z.enum(['AUTO', 'APPROVAL']).optional(),
  handoffHours: z.number().int().min(1).max(168).optional(),
  shopInfo: z.string().max(2000).nullable().optional(),
  deliveryEnabled: z.boolean().optional(),
  /** Major units, e.g. 5 or "5.00", in the merchant's currency. */
  deliveryFee: z.union([z.number().nonnegative(), z.string()]).optional(),
  pickupEnabled: z.boolean().optional(),
  pickupInfo: z.string().max(300).nullable().optional(),
});

/**
 * Dashboard routes for customer commerce: the shop's WhatsApp number and its settings, product
 * photos and visibility, and customer hand-offs. All scoped to the signed-in merchant.
 */
export async function customerCommerceRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const { db, config } = container;

  /** The bot number currently linked to the worker (full ID stays server-side). */
  const currentBot = async (): Promise<string | null> => {
    if (!config.WHATSAPP_GATEWAY_URL) return null;
    try {
      const res = await fetch(
        `${config.WHATSAPP_GATEWAY_URL.replace(/\/$/, '')}/internal/session`,
        {
          headers: { [HEADERS.internalToken]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(5_000),
        },
      );
      return ((await res.json()) as { botId?: string | null }).botId ?? null;
    } catch {
      return null;
    }
  };
  const masked = (wid: string) => `•••• ${wid.split('@')[0]!.slice(-4)}`;

  app.get('/api/whatsapp/account', async (request) => {
    const bot = await currentBot();
    const accounts = await container.whatsappAccounts.forMerchant(request.merchant.id);
    const owner = bot ? await container.whatsappAccounts.forBot(bot) : null;
    return {
      /** Server-wide switch (CUSTOMER_COMMERCE_ENABLED). */
      available: config.CUSTOMER_COMMERCE_ENABLED,
      bot: bot
        ? {
            number: masked(bot),
            connectedToThisBusiness: owner?.merchantId === request.merchant.id,
            connectedToAnotherBusiness: !!owner && owner.merchantId !== request.merchant.id,
          }
        : null,
      accounts: accounts.map((a) => ({
        id: a.id,
        number: masked(a.wid),
        active: a.wid === bot,
        customerCommerceEnabled: a.customerCommerceEnabled,
        paymentLinkMode: a.paymentLinkMode,
        handoffHours: a.handoffHours,
        shopInfo: a.shopInfo,
        deliveryEnabled: a.deliveryEnabled,
        deliveryFee: toMajorString(a.deliveryFeeMinor, request.merchant.preferredCurrency),
        currency: request.merchant.preferredCurrency,
        pickupEnabled: a.pickupEnabled,
        pickupInfo: a.pickupInfo,
      })),
    };
  });

  app.post('/api/whatsapp/account/connect', { preHandler: ownerOnly }, async (request, reply) => {
    const bot = await currentBot();
    if (!bot)
      return reply.status(409).send({ error: { message: 'The WhatsApp bot is not connected.' } });
    const account = await container.whatsappAccounts.connect(request.merchant.id, bot);
    return { id: account.id, number: masked(account.wid) };
  });

  app.put('/api/whatsapp/account/:id', { preHandler: ownerOnly }, async (request) => {
    const { id } = parse(idParams, request.params);
    const { deliveryFee, ...body } = parse(accountPatch, request.body);
    const settings = {
      ...body,
      ...(deliveryFee !== undefined
        ? { deliveryFeeMinor: toMinorUnits(deliveryFee, request.merchant.preferredCurrency) }
        : {}),
    };
    const account = await container.whatsappAccounts.update(request.merchant.id, id, settings, {
      customerCommerceAvailable: config.CUSTOMER_COMMERCE_ENABLED,
    });
    return { id: account.id, customerCommerceEnabled: account.customerCommerceEnabled };
  });

  // ─── Products: description, visibility, photo ─────────────────────────────

  const product = async (merchantId: string, id: string) => {
    const p = await db.product.findFirst({ where: { id, merchantId } });
    if (!p) throw new NotFoundError('Product', id);
    return p;
  };

  /** Edits a product. Prices and names are audited; a stock count goes through the ledger. */
  app.patch('/api/products/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(productPatch, request.body);
    const current = await product(request.merchant.id, id);
    const updated = await container.products.update(request.merchant.id, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
      ...(body.visibleToCustomers !== undefined
        ? { visibleToCustomers: body.visibleToCustomers }
        : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.reorderLevel !== undefined ? { reorderLevel: body.reorderLevel } : {}),
      ...(body.sku !== undefined ? { sku: body.sku || null } : {}),
      ...(body.unitPrice !== undefined
        ? { unitPriceMinor: toMinorUnits(body.unitPrice, current.currency) }
        : {}),
    });
    if (body.stockQuantity !== undefined && body.stockQuantity !== current.stockQuantity) {
      await container.inventory.adjust({
        merchantId: request.merchant.id,
        product: updated.name,
        setTo: body.stockQuantity,
        type: 'ADJUSTMENT',
        note: 'Stock count from the dashboard',
        actor: 'MERCHANT',
      });
    }
    return db.product.findUniqueOrThrow({ where: { id } });
  });

  /**
   * Uploads (or replaces) the product photo. Any JPEG/PNG/WebP up to IMAGE_MAX_UPLOAD_BYTES; it is
   * decoded, resized and stored in R2 (or the database) by the image service.
   */
  const maxUpload = container.config.IMAGE_MAX_UPLOAD_BYTES;
  const photoBody = z.object({
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((maxUpload * 4) / 3) + 8),
  });
  app.put(
    '/api/products/:id/image',
    { bodyLimit: Math.ceil(maxUpload * 1.4) + 64 * 1024 },
    async (request) => {
      const { id } = parse(idParams, request.params);
      const body = parse(photoBody, request.body);
      const saved = await container.productImages.save(
        request.merchant.id,
        id,
        Buffer.from(body.dataBase64, 'base64'),
        actorLabel(request),
      );
      return { ok: true, ...saved };
    },
  );

  app.delete('/api/products/:id/image', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await container.productImages.remove(request.merchant.id, id, actorLabel(request));
    return reply.status(204).send();
  });

  /** The photo (?size=thumb for the 320 px thumbnail), with an ETag for cheap revalidation. */
  app.get('/api/products/:id/image', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { size } = parse(imageQuery, request.query);
    const image = await container.productImages.read(request.merchant.id, id, size ?? 'main');
    if (!image) return reply.status(404).send({ error: { message: 'No photo' } });
    const etag = `"${image.version}-${size ?? 'main'}"`;
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply
      .header('content-type', image.mimeType)
      .header('etag', etag)
      .header('cache-control', 'private, max-age=300')
      .send(image.bytes);
  });

  // ─── Customer chats (hand-offs) ───────────────────────────────────────────

  app.get('/api/customer-chats', async (request) => {
    const now = Date.now();
    const chats = await container.customerChats.recentChats(request.merchant.id, 50);
    return chats.map((c) => ({
      customerId: c.customer?.id ?? null,
      customer: c.customer?.name ?? 'Unknown',
      waitingForPerson: !!c.handoffUntil && c.handoffUntil.getTime() > now,
      handoffUntil: c.handoffUntil,
      lastMessageAt: c.lastMessageAt,
    }));
  });

  app.post('/api/customers/:id/resume', async (request) => {
    const { id } = parse(idParams, request.params);
    return { resumed: await container.customerChats.resume(request.merchant.id, id, 'dashboard') };
  });
}
