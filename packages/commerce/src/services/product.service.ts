import type { Database, Product } from '@vca/database';
import type { AuditService } from './audit.service';
import { ConflictError, NotFoundError } from '@vca/shared';

/** Lowercase, strip punctuation, crude singularisation ("baskets" -> "basket"). */
export function normalizeProductTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/**
 * Picks the catalog product a spoken item name refers to, or null when there is no
 * confident single match. Deterministic so the same words always map to the same product.
 */
export function matchProduct<P extends Pick<Product, 'name' | 'sku'>>(
  products: P[],
  spoken: string,
): P | null {
  const query = normalizeProductTokens(spoken);
  if (query.length === 0) return null;
  const queryKey = query.join(' ');

  const scored = products
    .map((product) => {
      const tokens = normalizeProductTokens(product.name);
      const key = tokens.join(' ');
      let score = 0;
      if (key === queryKey || product.sku?.toLowerCase() === spoken.trim().toLowerCase()) score = 3;
      else if (query.every((t) => tokens.includes(t))) score = 2;
      else if (tokens.every((t) => query.includes(t))) score = 2;
      else if (query.some((t) => t.length > 3 && tokens.includes(t))) score = 1;
      return { product, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  const tied = scored.filter((s) => s.score === best.score);
  return tied.length === 1 ? best.product : null;
}

export class ProductService {
  constructor(
    private readonly db: Database,
    private readonly audit?: AuditService,
  ) {}

  list(merchantId: string, options: { activeOnly?: boolean } = {}) {
    return this.db.product.findMany({
      where: { merchantId, ...(options.activeOnly ? { active: true } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  async get(merchantId: string, id: string): Promise<Product> {
    const product = await this.db.product.findFirst({ where: { merchantId, id } });
    if (!product) throw new NotFoundError('Product', id);
    return product;
  }

  async create(
    merchantId: string,
    input: {
      name: string;
      unitPriceMinor: number;
      currency: string;
      sku?: string | null;
      description?: string | null;
      stockQuantity?: number | null;
    },
  ) {
    const name = input.name.trim();
    const existing = await this.db.product.findFirst({
      where: { merchantId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) throw new ConflictError(`'${existing.name}' is already in the catalog.`);
    const product = await this.db.product.create({
      data: {
        merchantId,
        name,
        unitPriceMinor: input.unitPriceMinor,
        currency: input.currency,
        sku: input.sku ?? null,
        description: input.description ?? null,
        stockQuantity: input.stockQuantity ?? null,
      },
    });
    await this.audit?.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'product.created',
      entityType: 'product',
      entityId: product.id,
      data: {
        product: product.name,
        priceMinor: product.unitPriceMinor,
        currency: product.currency,
      },
    });
    return product;
  }

  /** Updates catalog fields (a price change applies to new orders only); audited. */
  async update(
    merchantId: string,
    id: string,
    data: { unitPriceMinor?: number; active?: boolean; name?: string },
  ): Promise<Product> {
    const product = await this.get(merchantId, id);
    const updated = await this.db.product.update({ where: { id: product.id }, data });
    await this.audit?.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'product.updated',
      entityType: 'product',
      entityId: product.id,
      data: {
        product: product.name,
        ...(data.unitPriceMinor !== undefined
          ? { priceBeforeMinor: product.unitPriceMinor, priceAfterMinor: data.unitPriceMinor }
          : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });
    return updated;
  }

  async search(merchantId: string, query: string): Promise<Product[]> {
    const products = await this.list(merchantId, { activeOnly: true });
    const match = matchProduct(products, query);
    if (match) return [match];
    const tokens = normalizeProductTokens(query);
    return products.filter((p) => normalizeProductTokens(p.name).some((t) => tokens.includes(t)));
  }
}
