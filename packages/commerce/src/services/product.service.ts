import type { Database, Product } from '@vca/database';
import { NotFoundError } from '@vca/shared';

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
  constructor(private readonly db: Database) {}

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

  create(
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
    return this.db.product.create({
      data: {
        merchantId,
        name: input.name.trim(),
        unitPriceMinor: input.unitPriceMinor,
        currency: input.currency,
        sku: input.sku ?? null,
        description: input.description ?? null,
        stockQuantity: input.stockQuantity ?? null,
      },
    });
  }

  async search(merchantId: string, query: string): Promise<Product[]> {
    const products = await this.list(merchantId, { activeOnly: true });
    const match = matchProduct(products, query);
    if (match) return [match];
    const tokens = normalizeProductTokens(query);
    return products.filter((p) => normalizeProductTokens(p.name).some((t) => tokens.includes(t)));
  }
}
