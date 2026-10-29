import type { FastifyInstance } from 'fastify';
import { toMajorString, toMinorUnits } from '@vca/commerce';
import { HEADERS, NotFoundError, ValidationError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { ownerOnly } from '../../http/merchant-scope';
import { parse } from '../../http/validation';

export const MAX_PHOTO_BYTES = 1_000_000;

const idParams = z.object({ id: z.string().min(1).max(64) });
const photoBody = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png']),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8),
});
const productPatch = z.object({
  description: z.string().max(1000).nullable().optional(),
  visibleToCustomers: z.boolean().optional(),
});
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

/** Real JPEG/PNG only, whatever the declared type says. */
const looksLike = (bytes: Buffer, mimeType: string) =>
  mimeType === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

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

  app.patch('/api/products/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(productPatch, request.body);
    await product(request.merchant.id, id);
    return db.product.update({
      where: { id },
      data: {
        ...(body.description !== undefined
          ? { description: body.description?.trim() || null }
          : {}),
        ...(body.visibleToCustomers !== undefined
          ? { visibleToCustomers: body.visibleToCustomers }
          : {}),
      },
    });
  });

  app.put('/api/products/:id/image', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(photoBody, request.body);
    const p = await product(request.merchant.id, id);
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length > MAX_PHOTO_BYTES)
      throw new ValidationError('Photos must be 1 MB or smaller. Try a smaller JPEG.');
    if (!looksLike(bytes, body.mimeType)) throw new ValidationError('Upload a JPEG or PNG photo.');
    await db.productImage.upsert({
      where: { productId: p.id },
      update: { mimeType: body.mimeType, data: bytes, sizeBytes: bytes.length },
      create: { productId: p.id, mimeType: body.mimeType, data: bytes, sizeBytes: bytes.length },
    });
    await container.audit.record({
      merchantId: request.merchant.id,
      actor: 'MERCHANT',
      type: 'product.photo_updated',
      entityType: 'product',
      entityId: p.id,
      data: { product: p.name, sizeBytes: bytes.length },
    });
    return { ok: true, sizeBytes: bytes.length };
  });

  app.delete('/api/products/:id/image', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await product(request.merchant.id, id);
    await db.productImage.deleteMany({ where: { productId: id } });
    return reply.status(204).send();
  });

  app.get('/api/products/:id/image', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const image = await db.productImage.findFirst({
      where: { productId: id, product: { merchantId: request.merchant.id } },
    });
    if (!image) return reply.status(404).send({ error: { message: 'No photo' } });
    return reply
      .header('content-type', image.mimeType)
      .header('cache-control', 'private, max-age=60')
      .send(Buffer.from(image.data));
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
