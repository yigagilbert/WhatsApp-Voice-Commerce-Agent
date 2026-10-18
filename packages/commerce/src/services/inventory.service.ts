import type { AuditActor, Database, DatabaseTx, Product, StockMovementType } from '@vca/database';
import { NotFoundError, ValidationError, getCorrelationId } from '@vca/shared';
import { matchProduct, normalizeProductTokens } from './product.service';
import type { AuditService } from './audit.service';

export type StockStatus = 'OUT_OF_STOCK' | 'LOW' | 'OK' | 'NOT_TRACKED';

export const stockStatus = (p: Pick<Product, 'stockQuantity' | 'reorderLevel'>): StockStatus =>
  p.stockQuantity === null
    ? 'NOT_TRACKED'
    : p.stockQuantity <= 0
      ? 'OUT_OF_STOCK'
      : p.reorderLevel !== null && p.stockQuantity <= p.reorderLevel
        ? 'LOW'
        : 'OK';

/** A product that just fell to/below its reorder level (or ran out) and should be alerted once. */
export interface StockAlert {
  productId: string;
  name: string;
  stock: number;
  reorderLevel: number | null;
  status: 'LOW' | 'OUT_OF_STOCK';
}

const DAY_MS = 86_400_000;

/**
 * Inventory: an append-only stock ledger (StockMovement) behind Product.stockQuantity.
 * Paid orders reduce stock exactly once per order line; merchants restock and correct stock
 * through chat or the dashboard. Every change records who, why and the balance after it.
 */
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** One product by name or SKU for this merchant, or a clear question if ambiguous/unknown. */
  async resolve(merchantId: string, ref: string): Promise<Product> {
    const products = await this.db.product.findMany({ where: { merchantId } });
    const match = matchProduct(products, ref);
    if (match) return match;
    const tokens = normalizeProductTokens(ref);
    const partial = products.filter((p) =>
      normalizeProductTokens(p.name).some((t) => tokens.includes(t)),
    );
    if (partial.length > 1) {
      throw new ValidationError(
        `Several products match '${ref}': ${partial.map((p) => p.name).join(', ')}. Ask which one.`,
      );
    }
    if (partial[0]) return partial[0];
    throw new NotFoundError('Product', ref);
  }

  /**
   * Reduces stock for a paid order (inside the payment-completion transaction). Idempotent: the
   * ledger's unique (order, product, SALE) key means a replayed completion changes nothing.
   */
  async recordSale(orderId: string, tx: DatabaseTx): Promise<StockAlert[]> {
    const items = await tx.orderItem.findMany({
      where: { orderId, productId: { not: null } },
      include: { order: { select: { merchantId: true, reference: true } } },
    });
    const byProduct = new Map<string, { quantity: number; merchantId: string; ref: string }>();
    for (const item of items) {
      const entry = byProduct.get(item.productId!) ?? {
        quantity: 0,
        merchantId: item.order.merchantId,
        ref: item.order.reference,
      };
      entry.quantity += item.quantity;
      byProduct.set(item.productId!, entry);
    }
    const alerts: StockAlert[] = [];
    for (const [productId, { quantity, merchantId, ref }] of byProduct) {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product || product.stockQuantity === null) continue; // stock not tracked
      const already = await tx.stockMovement.findUnique({
        where: { orderId_productId_type: { orderId, productId, type: 'SALE' } },
      });
      if (already) continue;
      const updated = await tx.product.update({
        where: { id: productId },
        data: { stockQuantity: { decrement: quantity } },
      });
      await tx.stockMovement.create({
        data: {
          merchantId,
          productId,
          type: 'SALE',
          quantity: -quantity,
          balanceAfter: updated.stockQuantity!,
          orderId,
          note: `Order ${ref}`,
          actor: 'SYSTEM',
          correlationId: getCorrelationId() ?? null,
        },
      });
      const alert = await this.claimAlert(updated, tx);
      if (alert) alerts.push(alert);
    }
    return alerts;
  }

  /**
   * A merchant's stock change: `change` adds/removes units (restock +20, damaged -2) or `setTo`
   * records a stock count. Stock can't go below zero this way. Starts tracking untracked products.
   */
  async adjust(params: {
    merchantId: string;
    product: string;
    change?: number | undefined;
    setTo?: number | undefined;
    type: Exclude<StockMovementType, 'SALE'>;
    note?: string | undefined;
    actor?: AuditActor;
  }) {
    if ((params.change === undefined) === (params.setTo === undefined))
      throw new ValidationError('Give either a change (e.g. +20) or a new stock count, not both.');
    if (params.change === 0) throw new ValidationError('The change must not be zero.');
    const product = await this.resolve(params.merchantId, params.product);
    const before = product.stockQuantity ?? 0;
    const after = params.setTo ?? before + params.change!;
    if (after < 0) {
      throw new ValidationError(
        `${product.name} has ${before} in stock; removing ${-params.change!} would go below zero.`,
      );
    }
    const delta = after - before;
    return this.db.$transaction(async (tx) => {
      // Conditional on the stock we read, so two concurrent adjustments can't both apply blindly.
      const { count } = await tx.product.updateMany({
        where: { id: product.id, stockQuantity: product.stockQuantity },
        data: { stockQuantity: after },
      });
      if (count !== 1)
        throw new ValidationError('Stock changed at the same moment; please try again.');
      const movement = await tx.stockMovement.create({
        data: {
          merchantId: params.merchantId,
          productId: product.id,
          type: params.type,
          quantity: delta,
          balanceAfter: after,
          note: params.note?.slice(0, 200) ?? null,
          actor: params.actor ?? 'MERCHANT',
          correlationId: getCorrelationId() ?? null,
        },
      });
      await this.audit.record(
        {
          merchantId: params.merchantId,
          actor: params.actor ?? 'MERCHANT',
          type: 'inventory.adjusted',
          entityType: 'product',
          entityId: product.id,
          data: { product: product.name, type: params.type, change: delta, before, after },
        },
        tx,
      );
      const updated = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
      const alert = await this.claimAlert(updated, tx);
      return { product: updated, movement, before, after, alert };
    });
  }

  /** Sets (or clears) a product's reorder level. */
  async setReorderLevel(merchantId: string, productRef: string, level: number | null) {
    const product = await this.resolve(merchantId, productRef);
    const updated = await this.db.product.update({
      where: { id: product.id },
      data: { reorderLevel: level, lowStockAlertedAt: null },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'inventory.reorder_level_set',
      entityType: 'product',
      entityId: product.id,
      data: { product: product.name, reorderLevel: level },
    });
    return updated;
  }

  /**
   * Low-stock alerts fire once per crossing: the first time stock is at/below the reorder level
   * (or out), until stock is back above it.
   */
  private async claimAlert(product: Product, tx: DatabaseTx): Promise<StockAlert | null> {
    const status = stockStatus(product);
    if (status === 'OK' || status === 'NOT_TRACKED') {
      if (product.lowStockAlertedAt)
        await tx.product.update({ where: { id: product.id }, data: { lowStockAlertedAt: null } });
      return null;
    }
    const { count } = await tx.product.updateMany({
      where: { id: product.id, lowStockAlertedAt: null },
      data: { lowStockAlertedAt: new Date() },
    });
    if (count !== 1) return null;
    return {
      productId: product.id,
      name: product.name,
      stock: product.stockQuantity!,
      reorderLevel: product.reorderLevel,
      status,
    };
  }

  /**
   * Stock position per product with sales velocity from paid orders in the last `days` days.
   * `daysOfCover` and `suggestedReorder` are simple, labelled estimates (average daily sales).
   */
  async report(merchantId: string, now = new Date(), days = 30) {
    const since = new Date(now.getTime() - days * DAY_MS);
    const [products, sold] = await Promise.all([
      this.db.product.findMany({ where: { merchantId, active: true }, orderBy: { name: 'asc' } }),
      this.db.orderItem.groupBy({
        by: ['productId'],
        where: {
          productId: { not: null },
          order: {
            merchantId,
            status: 'PAID',
            payments: { some: { status: 'COMPLETED', completedAt: { gte: since } } },
          },
        },
        _sum: { quantity: true },
      }),
    ]);
    return products.map((p) => {
      const unitsSold = sold.find((s) => s.productId === p.id)?._sum.quantity ?? 0;
      const perDay = unitsSold / days;
      const stock = p.stockQuantity;
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        stock,
        reorderLevel: p.reorderLevel,
        status: stockStatus(p),
        unitsSoldLastPeriod: unitsSold,
        periodDays: days,
        daysOfCover: stock !== null && perDay > 0 ? Math.floor(stock / perDay) : null,
        suggestedReorder:
          stock !== null && perDay > 0
            ? Math.max(0, Math.ceil(perDay * days + (p.reorderLevel ?? 0) - stock))
            : null,
      };
    });
  }

  /** Recent stock ledger entries, optionally for one product. */
  async movements(merchantId: string, productRef?: string, limit = 20) {
    const product = productRef ? await this.resolve(merchantId, productRef) : null;
    return this.db.stockMovement.findMany({
      where: { merchantId, ...(product ? { productId: product.id } : {}) },
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }
}
