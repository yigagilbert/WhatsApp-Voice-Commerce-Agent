import type { Database, Product } from '@vca/database';
import type { AuditService } from './audit.service';
import { ConflictError, NotFoundError, ValidationError } from '@vca/shared';
import {
  parseQuantityTiers,
  validatePricingRules,
  type PricingRules,
  type QuantityTier,
} from '../bargaining';

/** Bargaining settings a merchant edits with a product (all optional on update). */
export interface ProductPricingInput {
  bargainingEnabled?: boolean;
  minPriceMinor?: number | null;
  quantityDiscounts?: QuantityTier[];
}

/** The pricing rules stored on a product, parsed (stored JSON is never trusted as is). */
export const pricingRulesOf = (
  product: Pick<
    Product,
    'unitPriceMinor' | 'bargainingEnabled' | 'minPriceMinor' | 'quantityDiscounts'
  >,
): PricingRules => ({
  unitPriceMinor: product.unitPriceMinor,
  // Bargaining without a minimum is never allowed, whatever the row says.
  bargainingEnabled: product.bargainingEnabled && product.minPriceMinor !== null,
  minPriceMinor: product.minPriceMinor,
  quantityDiscounts: parseQuantityTiers(product.quantityDiscounts),
});

/** Lowercase, strip punctuation, crude singularisation ("baskets" -> "basket"). */
/** Two saves racing for one SKU: the database's refusal, in the same words as the check. */
const rethrowDuplicateSku =
  (sku: string | null | undefined) =>
  (error: unknown): never => {
    if ((error as { code?: string }).code === 'P2002')
      throw new ConflictError(`SKU '${sku}' is already used by another product.`);
    throw error;
  };

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
      reorderLevel?: number | null;
      visibleToCustomers?: boolean;
      category?: string | null;
    } & ProductPricingInput,
  ) {
    const name = input.name.trim();
    const pricing = {
      bargainingEnabled: input.bargainingEnabled ?? false,
      minPriceMinor: input.minPriceMinor ?? null,
      quantityDiscounts: input.quantityDiscounts ?? [],
    };
    validatePricingRules({ unitPriceMinor: input.unitPriceMinor, ...pricing });
    const existing = await this.db.product.findFirst({
      where: { merchantId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) throw new ConflictError(`'${existing.name}' is already in the catalog.`);
    await this.assertSkuFree(merchantId, input.sku);
    const product = await this.db.product
      .create({
        data: {
          merchantId,
          name,
          unitPriceMinor: input.unitPriceMinor,
          currency: input.currency,
          sku: input.sku ?? null,
          description: input.description ?? null,
          category: input.category?.trim() || null,
          stockQuantity: input.stockQuantity ?? null,
          reorderLevel: input.reorderLevel ?? null,
          ...(input.visibleToCustomers !== undefined
            ? { visibleToCustomers: input.visibleToCustomers }
            : {}),
          bargainingEnabled: pricing.bargainingEnabled,
          minPriceMinor: pricing.minPriceMinor,
          quantityDiscounts: pricing.quantityDiscounts.map((t) => ({ ...t })),
        },
      })
      .catch(rethrowDuplicateSku(input.sku));
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
        ...(pricing.bargainingEnabled ? { bargainingEnabled: true } : {}),
        ...(pricing.quantityDiscounts.length
          ? { quantityDiscounts: pricing.quantityDiscounts }
          : {}),
      },
    });
    return product;
  }

  /** A SKU belongs to one product per merchant: says which one, instead of a database error. */
  private async assertSkuFree(
    merchantId: string,
    sku: string | null | undefined,
    exceptId?: string,
  ) {
    if (!sku) return;
    const clash = await this.db.product.findFirst({
      where: { merchantId, sku, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw new ConflictError(`SKU '${sku}' is already used by '${clash.name}'.`);
  }

  /** Updates catalog fields (a price change applies to new orders only); audited. */
  async update(
    merchantId: string,
    id: string,
    data: {
      unitPriceMinor?: number;
      active?: boolean;
      name?: string;
      description?: string | null;
      visibleToCustomers?: boolean;
      category?: string | null;
      reorderLevel?: number | null;
      sku?: string | null;
    } & ProductPricingInput,
  ): Promise<Product> {
    const product = await this.get(merchantId, id);
    // The rules are checked as they will be after the change (e.g. a new price under the minimum).
    const current = pricingRulesOf(product);
    const next: PricingRules = {
      unitPriceMinor: data.unitPriceMinor ?? product.unitPriceMinor,
      bargainingEnabled: data.bargainingEnabled ?? product.bargainingEnabled,
      minPriceMinor: data.minPriceMinor !== undefined ? data.minPriceMinor : product.minPriceMinor,
      quantityDiscounts: data.quantityDiscounts ?? current.quantityDiscounts,
    };
    validatePricingRules(next);
    const pricingChanged =
      next.bargainingEnabled !== product.bargainingEnabled ||
      next.minPriceMinor !== product.minPriceMinor ||
      JSON.stringify(next.quantityDiscounts) !== JSON.stringify(current.quantityDiscounts);
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new ValidationError('Give the product a name.');
      const clash = await this.db.product.findFirst({
        where: { merchantId, id: { not: id }, name: { equals: name, mode: 'insensitive' } },
      });
      if (clash) throw new ConflictError(`'${clash.name}' is already in the catalog.`);
      data = { ...data, name };
    }
    await this.assertSkuFree(merchantId, data.sku, id);
    const { quantityDiscounts, ...fields } = data;
    const updated = await this.db.product
      .update({
        where: { id: product.id },
        data: {
          ...fields,
          ...(quantityDiscounts !== undefined
            ? { quantityDiscounts: next.quantityDiscounts.map((t) => ({ ...t })) }
            : {}),
        },
      })
      .catch(rethrowDuplicateSku(data.sku));
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
        ...(data.name !== undefined && data.name !== product.name ? { renamedTo: data.name } : {}),
        ...(data.reorderLevel !== undefined ? { reorderLevel: data.reorderLevel } : {}),
        ...(data.visibleToCustomers !== undefined
          ? { visibleToCustomers: data.visibleToCustomers }
          : {}),
        // The minimum itself is not written to the audit trail (it is internal), only that it changed.
        ...(pricingChanged
          ? {
              bargainingEnabled: next.bargainingEnabled,
              minimumPriceChanged: next.minPriceMinor !== product.minPriceMinor,
              quantityDiscounts: next.quantityDiscounts,
            }
          : {}),
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
