import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  automaticUnitPrice,
  bundleQualifies,
  formatMoney,
  normalizeProductTokens,
  pricingRulesOf,
  type AuditService,
  type WhatsAppAccountService,
} from '@vca/commerce';
import type { Database, Prisma, Product } from '@vca/database';
import { ConflictError, NotFoundError, ValidationError, type Logger } from '@vca/shared';
import { availability, type Availability } from '../customer/catalog';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  RESERVING,
  type ShopActor,
  type ShopOrderService,
} from '../customer/shop-order.service';
import { processProductImage } from '../images/image-processing';
import type { ObjectStore } from '../images/object-store';

const MINUTE = 60_000;
/** How long a reference waits for the customer's WhatsApp message. */
export const CART_REFERENCE_TTL_MINUTES = 60;
/** Used references and expired ones are kept this long for support, then deleted. */
const TRANSFER_RETENTION_MS = 7 * 24 * 60 * MINUTE;
const LINKED_BOT_CACHE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 48;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;

/** The reference inside the WhatsApp message: 120 random bits in base32, e.g. KC-MZXW6YTBOI… */
export const CART_REFERENCE = /\bKC-([A-Z2-7]{24})\b/i;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const newCartReference = () => {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `KC-${out}`;
};

/** References are stored only as this hash, so a database read can't be replayed as a checkout. */
const hashReference = (reference: string) =>
  createHash('sha256').update(reference.toUpperCase()).digest('hex');

export const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'shop';

export type ProductSort = 'name' | 'price_asc' | 'price_desc' | 'newest';

export interface ProductQuery {
  q?: string | undefined;
  category?: string | undefined;
  sort?: ProductSort | undefined;
  inStock?: boolean | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface CartInputLine {
  productId: string;
  quantity: number;
}

export type CartIssue = 'unavailable' | 'out_of_stock' | 'insufficient' | 'limit' | 'currency';

export interface QuotedLine {
  productId: string;
  name: string | null;
  imageVersion: string | null;
  quantity: number;
  unitMinor: number;
  unit: string;
  /** The regular price when a discount applies. */
  listUnit: string | null;
  discount: 'QUANTITY' | 'BUNDLE' | null;
  lineTotal: string;
  availability: Availability | null;
  issue: CartIssue | null;
  message: string | null;
}

export interface CartQuote {
  lines: QuotedLine[];
  subtotal: string;
  savings: string | null;
  currency: string;
  /** Fingerprint of what the customer is looking at, sent back at checkout. */
  quote: string;
  ready: boolean;
  /** Set when the cart has more different products than one order can hold. */
  notice: string | null;
}

/** What a transfer row holds. Prices here are only for a "price changed" note; never charged. */
interface TransferItem {
  productId: string;
  name: string;
  quantity: number;
  seenUnitMinor: number;
}

export type CheckoutResult =
  | { status: 'unavailable' }
  | { status: 'invalid' | 'changed'; cart: CartQuote }
  | {
      status: 'ready';
      reference: string;
      whatsappUrl: string;
      expiresAt: Date;
      cart: CartQuote;
    };

export type ClaimResult =
  | { status: 'not_found' | 'expired' | 'used' | 'already_yours' }
  | { status: 'claimed'; added: number; notes: string[] };

type ProductWithImage = Product & { image: { id: string; updatedAt: Date } | null };

const imageSelect = { select: { id: true, updatedAt: true } } as const;

export interface StorefrontDeps {
  db: Database;
  audit: AuditService;
  accounts: WhatsAppAccountService;
  shop: ShopOrderService;
  logger: Logger;
  store: ObjectStore | null;
  customerCommerceAvailable: boolean;
  /** The bot number linked to the WhatsApp worker (null when none or unreachable). */
  linkedBot: () => Promise<string | null>;
  /** Public website address; without it the WhatsApp assistant sends no links. */
  webPublicUrl?: string | undefined;
}

/**
 * The public catalogue and the web-to-WhatsApp cart handoff. Website carts live in the browser and
 * are never trusted: every view is repriced here, and a handoff carries only product IDs and
 * quantities into the customer's ordinary WhatsApp cart, which then follows the existing checkout,
 * bargaining, PayPal and stock rules.
 */
export class StorefrontService {
  private linked: { at: number; wid: string | null } | null = null;

  constructor(private readonly deps: StorefrontDeps) {}

  // ─── Shop ────────────────────────────────────────────────────────────────

  private visibleWhere(merchantId: string): Prisma.ProductWhereInput {
    return { merchantId, active: true, visibleToCustomers: true };
  }

  /** The shop behind a URL. Unpublished shops are visible only to their own owner's preview. */
  private async find(slug: string, previewMerchantId?: string | null) {
    const shop = await this.deps.db.storefront.findUnique({
      where: { slug },
      select: {
        merchantId: true,
        slug: true,
        enabled: true,
        tagline: true,
        about: true,
        logoUpdatedAt: true,
        updatedAt: true,
        merchant: { select: { businessName: true, preferredCurrency: true, bundleMinItems: true } },
      },
    });
    if (!shop || (!shop.enabled && shop.merchantId !== previewMerchantId))
      throw new NotFoundError('Shop', slug);
    return shop;
  }

  async merchantIdOf(slug: string, previewMerchantId?: string | null) {
    return (await this.find(slug, previewMerchantId)).merchantId;
  }

  async publicShop(slug: string, previewMerchantId?: string | null) {
    const shop = await this.find(slug, previewMerchantId);
    const where = this.visibleWhere(shop.merchantId);
    const [groups, phone, account] = await Promise.all([
      this.deps.db.product.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
        orderBy: { category: 'asc' },
      }),
      this.checkoutNumber(shop.merchantId),
      this.deps.db.whatsAppAccount.findFirst({
        where: { merchantId: shop.merchantId, customerCommerceEnabled: true },
        orderBy: { createdAt: 'asc' },
        select: { shopInfo: true },
      }),
    ]);
    return {
      slug: shop.slug,
      name: shop.merchant.businessName,
      tagline: shop.tagline,
      about: shop.about,
      shopInfo: account?.shopInfo ?? null,
      logoVersion: shop.logoUpdatedAt ? String(shop.logoUpdatedAt.getTime()) : null,
      currency: shop.merchant.preferredCurrency,
      checkoutAvailable: !!phone,
      /** Only for "ask a question" links. Checkout links are built by the backend. */
      whatsappNumber: phone,
      preview: !shop.enabled,
      totalProducts: groups.reduce((sum, g) => sum + g._count._all, 0),
      categories: groups
        .filter((g): g is typeof g & { category: string } => !!g.category)
        .map((g) => ({ name: g.category, count: g._count._all })),
    };
  }

  /** Published shops, for /shop and the sitemap. */
  publishedShops() {
    return this.deps.db.storefront.findMany({
      where: { enabled: true },
      select: { slug: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  async productIds(slug: string) {
    const shop = await this.find(slug);
    return this.deps.db.product.findMany({
      where: this.visibleWhere(shop.merchantId),
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
      take: 5000,
    });
  }

  // ─── Catalogue ───────────────────────────────────────────────────────────

  /** Units held by unpaid orders, per product, for this merchant. */
  private async reservedUnits(merchantId: string, productIds?: string[]) {
    const reserved = await this.deps.db.orderItem.groupBy({
      by: ['productId'],
      where: {
        productId: productIds ? { in: productIds } : { not: null },
        order: { merchantId, ...RESERVING },
      },
      _sum: { quantity: true },
    });
    return new Map(reserved.map((r) => [r.productId!, r._sum.quantity ?? 0]));
  }

  private withHeldStock<P extends Pick<Product, 'id' | 'stockQuantity'>>(
    product: P,
    held: Map<string, number>,
  ): P {
    return product.stockQuantity === null
      ? product
      : {
          ...product,
          stockQuantity: Math.max(0, product.stockQuantity - (held.get(product.id) ?? 0)),
        };
  }

  /** A product as the public sees it: no stock counts, SKUs, costs or minimum prices. */
  private view(product: ProductWithImage) {
    const rules = pricingRulesOf(product);
    return {
      id: product.id,
      name: product.name,
      description: product.description?.trim() || null,
      category: product.category,
      priceMinor: product.unitPriceMinor,
      price: formatMoney(product.unitPriceMinor, product.currency),
      currency: product.currency,
      availability: availability(product),
      imageVersion: product.image
        ? `${product.image.id}-${product.image.updatedAt.getTime()}`
        : null,
      negotiable: rules.bargainingEnabled,
      deals: rules.quantityDiscounts.map((t) => ({
        minQuantity: t.minQuantity,
        percentOff: t.percentOff,
      })),
    };
  }

  /** One page of products, from the database: a shop's size doesn't change the cost of a page. */
  async listProducts(merchantId: string, query: ProductQuery) {
    const { db } = this.deps;
    const words = normalizeProductTokens(query.q?.trim() ?? '').slice(0, 6);
    const and: Prisma.ProductWhereInput[] = words.map((word) => ({
      OR: [
        { name: { contains: word, mode: 'insensitive' } },
        { description: { contains: word, mode: 'insensitive' } },
        { category: { contains: word, mode: 'insensitive' } },
      ],
    }));
    if (query.category) and.push({ category: { equals: query.category, mode: 'insensitive' } });
    const held = await this.reservedUnits(merchantId);
    if (query.inStock) {
      // Sold out includes units held by unpaid orders, the same rule the cart applies.
      const tracked = held.size
        ? await db.product.findMany({
            where: { merchantId, id: { in: [...held.keys()] }, stockQuantity: { not: null } },
            select: { id: true, stockQuantity: true },
          })
        : [];
      const soldOut = tracked
        .filter((p) => p.stockQuantity! <= (held.get(p.id) ?? 0))
        .map((p) => p.id);
      and.push({ OR: [{ stockQuantity: null }, { stockQuantity: { gt: 0 } }] });
      if (soldOut.length) and.push({ id: { notIn: soldOut } });
    }
    const where: Prisma.ProductWhereInput = { ...this.visibleWhere(merchantId), AND: and };
    const pageSize = Math.min(Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const total = await db.product.count({ where });
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, query.page ?? 1), pages);
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = [
      query.sort === 'price_asc'
        ? { unitPriceMinor: 'asc' }
        : query.sort === 'price_desc'
          ? { unitPriceMinor: 'desc' }
          : query.sort === 'newest'
            ? { createdAt: 'desc' }
            : { name: 'asc' },
      { id: 'asc' },
    ];
    const products = await db.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { image: imageSelect },
    });
    return {
      products: products.map((p) => this.view(this.withHeldStock(p, held))),
      total,
      page,
      pages,
      pageSize,
    };
  }

  async product(merchantId: string, productId: string) {
    const product = await this.deps.db.product.findFirst({
      where: { id: productId, ...this.visibleWhere(merchantId) },
      include: { image: imageSelect },
    });
    if (!product) throw new NotFoundError('Product', productId);
    const held = await this.reservedUnits(merchantId, [product.id]);
    const related = product.category
      ? await this.deps.db.product.findMany({
          where: {
            ...this.visibleWhere(merchantId),
            category: product.category,
            id: { not: product.id },
          },
          orderBy: { name: 'asc' },
          take: 4,
          include: { image: imageSelect },
        })
      : [];
    const heldRelated = await this.reservedUnits(
      merchantId,
      related.map((p) => p.id),
    );
    return {
      ...this.view(this.withHeldStock(product, held)),
      related: related.map((p) => this.view(this.withHeldStock(p, heldRelated))),
    };
  }

  // ─── Cart ────────────────────────────────────────────────────────────────

  /**
   * The browser's cart priced by the backend: current prices, quantity and bundle discounts
   * (negotiated prices exist only on WhatsApp), stock net of unpaid orders. Never reveals stock
   * counts. Problem lines stay in the result so the customer can fix them.
   */
  async priceCart(merchantId: string, input: CartInputLine[]): Promise<CartQuote> {
    const { db } = this.deps;
    const merged = new Map<string, number>();
    for (const line of input)
      merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
    const ids = [...merged.keys()];
    const [products, held, merchant] = await Promise.all([
      db.product.findMany({
        where: { id: { in: ids }, ...this.visibleWhere(merchantId) },
        include: { image: imageSelect },
      }),
      this.reservedUnits(merchantId, ids),
      db.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { preferredCurrency: true, bundleMinItems: true, bundlePercentOff: true },
      }),
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));
    const currency = products[0]?.currency ?? merchant.preferredCurrency;
    const money = (minor: number) => formatMoney(minor, currency);

    const issueOf = (product: Product | undefined, quantity: number): CartIssue | null => {
      if (!product) return 'unavailable';
      if (product.currency !== currency) return 'currency';
      if (quantity > MAX_LINE_QUANTITY) return 'limit';
      if (product.stockQuantity === null) return null;
      const left = product.stockQuantity - (held.get(product.id) ?? 0);
      return left <= 0 ? 'out_of_stock' : left < quantity ? 'insufficient' : null;
    };
    const message: Record<CartIssue, string> = {
      unavailable: 'No longer available. Remove it to continue.',
      out_of_stock: 'Out of stock. Remove it to continue.',
      insufficient: 'Not enough in stock for this quantity. Choose fewer.',
      limit: `You can order up to ${MAX_LINE_QUANTITY} of one product here. Choose fewer.`,
      currency: 'Priced in another currency. Order it separately.',
    };

    const bundleRule =
      merchant.bundleMinItems && merchant.bundlePercentOff
        ? { minItems: merchant.bundleMinItems, percentOff: merchant.bundlePercentOff }
        : null;
    const bundle = bundleQualifies(
      bundleRule,
      ids.flatMap((id) => {
        const product = byId.get(id);
        if (!product || issueOf(product, merged.get(id)!)) return [];
        return [{ productId: id, bargainingEnabled: pricingRulesOf(product).bargainingEnabled }];
      }),
    )
      ? bundleRule
      : null;

    const lines: QuotedLine[] = ids.map((id) => {
      const quantity = merged.get(id)!;
      const product = byId.get(id);
      const issue = issueOf(product, quantity);
      if (!product)
        return {
          productId: id,
          name: null,
          imageVersion: null,
          quantity,
          unitMinor: 0,
          unit: '',
          listUnit: null,
          discount: null,
          lineTotal: '',
          availability: null,
          issue,
          message: issue && message[issue],
        };
      const auto = automaticUnitPrice(pricingRulesOf(product), quantity, bundle);
      return {
        productId: id,
        name: product.name,
        imageVersion: product.image
          ? `${product.image.id}-${product.image.updatedAt.getTime()}`
          : null,
        quantity,
        unitMinor: auto.unitMinor,
        unit: money(auto.unitMinor),
        listUnit: auto.unitMinor < product.unitPriceMinor ? money(product.unitPriceMinor) : null,
        discount: auto.pricing === 'LIST' ? null : auto.pricing,
        lineTotal: money(auto.unitMinor * quantity),
        availability: availability(this.withHeldStock(product, held)),
        issue,
        message: issue && message[issue],
      };
    });

    const payable = lines.filter((l) => !l.issue);
    const subtotalMinor = payable.reduce((sum, l) => sum + l.unitMinor * l.quantity, 0);
    const savings = payable.reduce((sum, l) => {
      const regular = byId.get(l.productId)!.unitPriceMinor;
      return sum + (regular - l.unitMinor) * l.quantity;
    }, 0);
    const tooMany = ids.length > MAX_CART_LINES;
    return {
      lines,
      subtotal: money(subtotalMinor),
      savings: savings > 0 ? money(savings) : null,
      currency,
      quote: createHash('sha256')
        .update(JSON.stringify(lines.map((l) => [l.productId, l.quantity, l.unitMinor, l.issue])))
        .digest('hex')
        .slice(0, 16),
      ready: lines.length > 0 && !tooMany && lines.every((l) => !l.issue),
      notice: tooMany
        ? `One order can hold ${MAX_CART_LINES} different products. Remove ${ids.length - MAX_CART_LINES} to continue.`
        : null,
    };
  }

  // ─── WhatsApp handoff ────────────────────────────────────────────────────

  private async linkedBot() {
    if (!this.linked || Date.now() - this.linked.at > LINKED_BOT_CACHE_MS)
      this.linked = { at: Date.now(), wid: await this.deps.linkedBot() };
    return this.linked.wid;
  }

  private checkoutNumber(merchantId: string) {
    return this.linkedBot().then((linked) =>
      this.deps.accounts.storefrontNumber(merchantId, linked, {
        customerCommerceAvailable: this.deps.customerCommerceAvailable,
      }),
    );
  }

  /**
   * "Checkout on WhatsApp": checks the cart, then creates the short-lived reference the customer
   * sends to the shop's own number. Nothing about the customer is known or stored here, and opening
   * the link changes nothing: the checkout starts only when the message reaches the bot.
   */
  async checkout(
    slug: string,
    input: { items: CartInputLine[]; quote: string; clientKey?: string | undefined },
    now = new Date(),
  ): Promise<CheckoutResult> {
    const shop = await this.find(slug);
    const phone = await this.checkoutNumber(shop.merchantId);
    if (!phone) return { status: 'unavailable' };
    const cart = await this.priceCart(shop.merchantId, input.items);
    if (!cart.ready) return { status: 'invalid', cart };
    if (cart.quote !== input.quote) return { status: 'changed', cart };

    const reference = newCartReference();
    const expiresAt = new Date(now.getTime() + CART_REFERENCE_TTL_MINUTES * MINUTE);
    const items: TransferItem[] = cart.lines.map((l) => ({
      productId: l.productId,
      name: l.name!,
      quantity: l.quantity,
      seenUnitMinor: l.unitMinor,
    }));
    await this.deps.db.$transaction(async (tx) => {
      // Only the latest checkout of a browser's cart stays valid.
      if (input.clientKey)
        await tx.cartTransfer.updateMany({
          where: { merchantId: shop.merchantId, clientKey: input.clientKey, status: 'OPEN' },
          data: { status: 'SUPERSEDED' },
        });
      await tx.cartTransfer.create({
        data: {
          merchantId: shop.merchantId,
          tokenHash: hashReference(reference),
          clientKey: input.clientKey ?? null,
          items: items as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
      });
    });
    const text = `Hi ${shop.merchant.businessName}! I'd like to check out my cart from your website.\n\nCart reference: ${reference}`;
    return {
      status: 'ready',
      reference,
      whatsappUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`,
      expiresAt,
      cart,
    };
  }

  /** For the browser that holds the reference: has the shop received this cart yet? */
  async transferStatus(slug: string, reference: string, now = new Date()) {
    const shop = await this.find(slug);
    const transfer = await this.deps.db.cartTransfer.findFirst({
      where: { merchantId: shop.merchantId, tokenHash: hashReference(reference) },
      select: { status: true, expiresAt: true },
    });
    if (!transfer) return 'expired' as const;
    if (transfer.status === 'CLAIMED') return 'received' as const;
    return transfer.status === 'OPEN' && transfer.expiresAt > now
      ? ('waiting' as const)
      : ('expired' as const);
  }

  /**
   * The customer's message reached the bot: binds the reference to this merchant and customer and
   * moves the items into their WhatsApp cart, all in one transaction. The conditional update is
   * the single-use guard: of two racing messages exactly one gets the row. A refused cart (e.g. too
   * many unpaid orders) rolls back, so the reference still works once the customer has sorted it.
   */
  async claim(actor: ShopActor, reference: string, now = new Date()): Promise<ClaimResult> {
    const { db, audit, shop } = this.deps;
    const merchantId = actor.merchant.id;
    const transfer = await db.cartTransfer.findFirst({
      where: { merchantId, tokenHash: hashReference(reference) },
    });
    // Another shop's reference looks exactly like one that never existed.
    if (!transfer) return { status: 'not_found' };
    if (transfer.status === 'CLAIMED')
      return { status: transfer.customerId === actor.customer.id ? 'already_yours' : 'used' };
    if (transfer.status === 'SUPERSEDED' || transfer.expiresAt <= now) return { status: 'expired' };

    return db.$transaction(async (tx): Promise<ClaimResult> => {
      const claimed = await tx.cartTransfer.updateMany({
        where: { id: transfer.id, status: 'OPEN', expiresAt: { gt: now } },
        data: { status: 'CLAIMED', customerId: actor.customer.id, claimedAt: now },
      });
      if (claimed.count !== 1) {
        const latest = await tx.cartTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
        if (latest.status !== 'CLAIMED') return { status: 'expired' };
        return { status: latest.customerId === actor.customer.id ? 'already_yours' : 'used' };
      }
      const imported = await shop.importLines(
        tx,
        actor,
        transfer.items as unknown as TransferItem[],
        now,
      );
      await tx.cartTransfer.update({
        where: { id: transfer.id },
        data: { orderId: imported.orderId },
      });
      await audit.record(
        {
          merchantId,
          actor: 'SYSTEM',
          type: 'storefront.cart_claimed',
          entityType: 'customer',
          entityId: actor.customer.id,
          data: { transfer: transfer.id, added: imported.added, orderId: imported.orderId },
        },
        tx,
      );
      return { status: 'claimed', added: imported.added, notes: imported.notes };
    });
  }

  /** Scheduler: used and expired references don't accumulate. */
  async purgeTransfers(now = new Date()) {
    const { count } = await this.deps.db.cartTransfer.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - TRANSFER_RETENTION_MS) } },
    });
    return count;
  }

  // ─── Links for the WhatsApp assistant ────────────────────────────────────

  /** The public link to the shop, a product or a category; null unless the shop is published. */
  async link(
    merchantId: string,
    target: { productId?: string; category?: string; query?: string } = {},
  ) {
    const base = this.deps.webPublicUrl?.replace(/\/$/, '');
    if (!base) return null;
    const shop = await this.deps.db.storefront.findUnique({
      where: { merchantId },
      select: { slug: true, enabled: true },
    });
    if (!shop?.enabled) return null;
    const root = `${base}/shop/${shop.slug}`;
    if (target.productId) return `${root}/p/${encodeURIComponent(target.productId)}`;
    if (target.category) return `${root}?category=${encodeURIComponent(target.category)}`;
    if (target.query) return `${root}?q=${encodeURIComponent(target.query)}`;
    return root;
  }

  // ─── Images ──────────────────────────────────────────────────────────────

  async readLogo(slug: string, previewMerchantId?: string | null) {
    const shop = await this.find(slug, previewMerchantId);
    const row = await this.deps.db.storefront.findUniqueOrThrow({
      where: { merchantId: shop.merchantId },
      select: {
        logoMimeType: true,
        logoStorage: true,
        logoData: true,
        logoKey: true,
        logoUpdatedAt: true,
      },
    });
    if (!row.logoMimeType || !row.logoUpdatedAt) return null;
    const bytes =
      row.logoStorage === 'R2'
        ? row.logoKey && this.deps.store
          ? await this.deps.store.get(row.logoKey)
          : null
        : row.logoData && Buffer.from(row.logoData);
    return bytes
      ? { bytes, mimeType: row.logoMimeType, version: String(row.logoUpdatedAt.getTime()) }
      : null;
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  /** Why the storefront can't send customers to WhatsApp right now (null = it can). */
  private async checkoutBlocker(merchantId: string) {
    if (!this.deps.customerCommerceAvailable)
      return 'Customer shopping is switched off on this server.';
    const accounts = await this.deps.accounts.forMerchant(merchantId);
    if (!accounts.length) return 'Connect your WhatsApp number on the WhatsApp page.';
    if (!accounts.some((a) => a.customerCommerceEnabled))
      return 'Turn on customer shopping on the WhatsApp page.';
    if (!(await this.checkoutNumber(merchantId)))
      return 'The WhatsApp bot is linked to a different number. Connect this shop’s number.';
    return null;
  }

  async settings(merchant: { id: string; businessName: string }) {
    const { db } = this.deps;
    const shop = await db.storefront.findUnique({
      where: { merchantId: merchant.id },
      select: { slug: true, enabled: true, tagline: true, about: true, logoUpdatedAt: true },
    });
    const visible = this.visibleWhere(merchant.id);
    const [shown, hidden, withoutPhoto, withoutCategory, categories, blocker] = await Promise.all([
      db.product.count({ where: visible }),
      db.product.count({
        where: { merchantId: merchant.id, active: true, visibleToCustomers: false },
      }),
      db.product.count({ where: { ...visible, image: null } }),
      db.product.count({ where: { ...visible, category: null } }),
      db.product.groupBy({
        by: ['category'],
        where: { ...visible, category: { not: null } },
        _count: { _all: true },
        orderBy: { category: 'asc' },
      }),
      this.checkoutBlocker(merchant.id),
    ]);
    return {
      slug: shop?.slug ?? (await this.freeSlug(slugify(merchant.businessName), merchant.id)),
      saved: !!shop,
      enabled: shop?.enabled ?? false,
      tagline: shop?.tagline ?? null,
      about: shop?.about ?? null,
      logoVersion: shop?.logoUpdatedAt ? String(shop.logoUpdatedAt.getTime()) : null,
      checkoutBlocker: blocker,
      products: { shown, hidden, withoutPhoto, withoutCategory },
      categories: categories.map((c) => ({ name: c.category!, count: c._count._all })),
    };
  }

  /** A suggested address nobody else uses: "kampala-crafts", then "kampala-crafts-2". */
  private async freeSlug(base: string, merchantId: string) {
    const start = base.length >= 3 ? base : `${base}-shop`;
    for (let n = 1; n < 50; n++) {
      const candidate = n === 1 ? start : `${start}-${n}`;
      const taken = await this.deps.db.storefront.findUnique({ where: { slug: candidate } });
      if (!taken || taken.merchantId === merchantId) return candidate;
    }
    return `${start}-${randomUUID().slice(0, 6)}`;
  }

  async save(
    merchantId: string,
    input: { slug: string; enabled: boolean; tagline: string | null; about: string | null },
    by: string,
  ) {
    if (!SLUG.test(input.slug))
      throw new ValidationError(
        'Use 3–60 lowercase letters, numbers and hyphens for your shop address.',
      );
    const taken = await this.deps.db.storefront.findUnique({ where: { slug: input.slug } });
    if (taken && taken.merchantId !== merchantId)
      throw new ConflictError('Another shop already uses that address. Try a different one.');
    const data = {
      slug: input.slug,
      enabled: input.enabled,
      tagline: input.tagline?.trim() || null,
      about: input.about?.trim() || null,
    };
    const shop = await this.deps.db.storefront.upsert({
      where: { merchantId },
      update: data,
      create: { merchantId, ...data },
      select: { slug: true, enabled: true },
    });
    await this.deps.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'storefront.updated',
      entityType: 'storefront',
      entityId: merchantId,
      data: { ...shop, by },
    });
    return shop;
  }

  /** The logo reuses the product photo checks: decoded, stripped of metadata, 320 px square. */
  async saveLogo(merchant: { id: string; businessName: string }, upload: Buffer, by: string) {
    const { db, store } = this.deps;
    const image = await processProductImage(upload);
    const existing = await db.storefront.findUnique({
      where: { merchantId: merchant.id },
      select: { logoKey: true },
    });
    const key = store ? `merchants/${merchant.id}/logo/${randomUUID()}.jpg` : null;
    if (store && key) await store.put(key, image.thumb, image.mimeType);
    const fields = {
      logoMimeType: image.mimeType,
      logoStorage: store ? ('R2' as const) : ('DATABASE' as const),
      logoKey: key,
      logoData: store ? null : new Uint8Array(image.thumb),
      logoUpdatedAt: new Date(),
    };
    await db.storefront.upsert({
      where: { merchantId: merchant.id },
      update: fields,
      create: {
        merchantId: merchant.id,
        slug: await this.freeSlug(slugify(merchant.businessName), merchant.id),
        ...fields,
      },
      select: { merchantId: true },
    });
    await this.removeObject(existing?.logoKey);
    await this.deps.audit.record({
      merchantId: merchant.id,
      actor: 'MERCHANT',
      type: 'storefront.logo_updated',
      entityType: 'storefront',
      entityId: merchant.id,
      data: { by },
    });
  }

  async removeLogo(merchantId: string) {
    const existing = await this.deps.db.storefront.findUnique({
      where: { merchantId },
      select: { logoKey: true },
    });
    if (!existing) return;
    await this.deps.db.storefront.update({
      where: { merchantId },
      data: {
        logoMimeType: null,
        logoStorage: null,
        logoKey: null,
        logoData: null,
        logoUpdatedAt: null,
      },
      select: { merchantId: true },
    });
    await this.removeObject(existing.logoKey);
  }

  private async removeObject(key: string | null | undefined) {
    if (!key || !this.deps.store) return;
    await this.deps.store
      .delete(key)
      .catch((error: unknown) =>
        this.deps.logger.warn({ err: error, key }, 'could not delete old logo object'),
      );
  }
}
