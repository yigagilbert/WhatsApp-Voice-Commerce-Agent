import { closestMatches, formatMoney, normalizeProductTokens, stockStatus } from '@vca/commerce';
import type { Database, Product } from '@vca/database';
import type { OutboundMedia } from '@vca/shared';

export type Availability = 'In stock' | 'Low stock' | 'Out of stock';

/** What customers may know about stock: never the quantity. Untracked stock counts as in stock. */
export const availability = (p: Pick<Product, 'stockQuantity' | 'reorderLevel'>): Availability => {
  const status = stockStatus(p);
  return status === 'OUT_OF_STOCK' ? 'Out of stock' : status === 'LOW' ? 'Low stock' : 'In stock';
};

/** A product as a customer sees it. No stock counts, SKUs, costs or internal fields. */
export interface CustomerProduct {
  id: string;
  name: string;
  price: string;
  availability: Availability;
  description: string | null;
  hasPhoto: boolean;
}

export const PAGE_SIZE = 8;

/**
 * The merchant's catalog as customers see it: active products the merchant chose to show, with
 * prices from the database and stock as In stock / Low stock / Out of stock only. Every query is
 * scoped to one merchant (the bot's).
 */
export class CustomerCatalog {
  constructor(private readonly db: Database) {}

  private visible(merchantId: string) {
    return this.db.product.findMany({
      where: { merchantId, active: true, visibleToCustomers: true },
      include: { image: { select: { id: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
  }

  private view(p: Product & { image: { id: string } | null }): CustomerProduct {
    return {
      id: p.id,
      name: p.name,
      price: formatMoney(p.unitPriceMinor, p.currency),
      availability: availability(p),
      description: p.description?.trim() || null,
      hasPhoto: !!p.image,
    };
  }

  /**
   * A page of products, optionally filtered by a natural-language query ("baskets", "something
   * for coffee"). Falls back to the closest names when nothing matches word for word.
   */
  async search(merchantId: string, query?: string | null, page = 1) {
    const products = await this.visible(merchantId);
    let matches = products;
    const q = query?.trim();
    if (q) {
      const words = normalizeProductTokens(q).filter((w) => w.length > 2);
      const scored = products
        .map((p) => {
          const haystack = normalizeProductTokens(`${p.name} ${p.description ?? ''}`);
          return { p, score: words.filter((w) => haystack.some((h) => h.startsWith(w))).length };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      matches = scored.map((s) => s.p);
      if (!matches.length) {
        const close = new Set(
          closestMatches(
            q,
            products.map((p) => p.name),
            5,
          ),
        );
        matches = products.filter((p) => close.has(p.name));
      }
    }
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const slice = matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
    return {
      query: q || null,
      total: matches.length,
      page: current,
      pages,
      products: slice.map((p) => this.view(p)),
      /** All matching IDs in list order, so "12" works on page 2. */
      ids: matches.slice(0, 200).map((p) => p.id),
    };
  }

  /** One visible product of this merchant, by ID or by name. */
  async find(merchantId: string, idOrName: string): Promise<CustomerProduct | null> {
    const products = await this.visible(merchantId);
    const byId = products.find((p) => p.id === idOrName);
    if (byId) return this.view(byId);
    const words = normalizeProductTokens(idOrName);
    const exact = products.find(
      (p) => normalizeProductTokens(p.name).join(' ') === words.join(' '),
    );
    if (exact) return this.view(exact);
    const partial = products.filter((p) => {
      const tokens = normalizeProductTokens(p.name);
      return words.length > 0 && words.every((w) => tokens.some((t) => t.startsWith(w)));
    });
    return partial.length === 1 ? this.view(partial[0]!) : null;
  }

  /** The product photo as a WhatsApp image, if the merchant uploaded one. */
  async photo(merchantId: string, productId: string): Promise<OutboundMedia | null> {
    const image = await this.db.productImage.findFirst({
      where: { productId, product: { merchantId, active: true, visibleToCustomers: true } },
    });
    if (!image || (image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/png')) return null;
    return {
      mimeType: image.mimeType,
      dataBase64: Buffer.from(image.data).toString('base64'),
      filename: image.mimeType === 'image/png' ? 'product.png' : 'product.jpg',
    };
  }

  /** The numbered list customers reply to ("Reply 2 to see details"). */
  static formatList(result: Awaited<ReturnType<CustomerCatalog['search']>>): string {
    if (!result.total)
      return result.query
        ? `I couldn't find anything matching "${result.query}". Reply *1* to see everything we sell, or describe what you're looking for.`
        : "We don't have products listed yet. Reply *3* to talk to the team.";
    const start = (result.page - 1) * PAGE_SIZE;
    return [
      result.query ? `*Results for "${result.query}"*` : '*Our products*',
      ...result.products.map(
        (p, i) => `${start + i + 1}. ${p.name} — ${p.price} · ${p.availability}`,
      ),
      '',
      [
        'Reply with a number for details',
        result.page < result.pages ? '*more* for the next page' : null,
        'or ask me anything.',
      ]
        .filter(Boolean)
        .join(', '),
    ].join('\n');
  }

  static formatDetails(p: CustomerProduct): string {
    return [
      `*${p.name}*`,
      `${p.price} · ${p.availability}`,
      ...(p.description ? ['', p.description] : []),
      '',
      'Reply *menu* for more options or ask me a question.',
    ].join('\n');
  }
}
