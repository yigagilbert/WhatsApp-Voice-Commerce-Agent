import { randomInt } from 'node:crypto';
import type {
  Database,
  DatabaseTx,
  FulfillmentStatus,
  Merchant,
  OrderInputMode,
  OrderStatus,
} from '@vca/database';
import { NotFoundError, ValidationError } from '@vca/shared';
import type { DraftOrderCommand, SalesPeriod } from '../commands';
import { formatMoney, normalizeCurrency, toMinorUnits } from '../money';
import { calculateOrderTotals, type OrderTotals, type PricingLineInput } from '../pricing';
import { assertOrderTransition } from '../state';
import type { AuditService } from './audit.service';
import type { CustomerService } from './customer.service';
import { matchProduct } from './product.service';
import { resolvePeriod } from '../periods';
import { closestMatches } from '../similarity';

const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A customer's cart (an unconfirmed draft) is not an order for the merchant yet. */
export const NOT_OPEN_CART = {
  NOT: { placedBy: 'CUSTOMER' as const, status: 'DRAFT' as const, customerConfirmedAt: null },
};

export const generateOrderReference = (): string =>
  `ORD-${Array.from({ length: 6 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join('')}`;

const orderInclude = {
  items: { orderBy: { position: 'asc' } },
  customer: true,
  payments: { orderBy: { createdAt: 'desc' } },
} as const;

export interface PricedCommand {
  totals: OrderTotals;
  /** Non-blocking issues for the merchant (stock, price overrides, AI total mismatch). */
  warnings: string[];
}

export interface DraftOrderResult {
  order: Awaited<ReturnType<OrderService['getByReference']>>;
  isNewCustomer: boolean;
  /** Non-blocking issues for the merchant (stock, price overrides, AI total mismatch). */
  warnings: string[];
}

export interface OrderFilter {
  status?: OrderStatus;
  period?: SalesPeriod;
  /** Customer name (partial, case-insensitive). */
  customer?: string;
  inputMode?: OrderInputMode;
  fulfillment?: FulfillmentStatus;
  source?: string;
  limit?: number;
}

export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly customers: CustomerService,
    private readonly audit: AuditService,
  ) {}

  list(merchantId: string, options: { status?: OrderStatus; limit?: number } = {}) {
    return this.db.order.findMany({
      where: {
        merchantId,
        ...NOT_OPEN_CART,
        ...(options.status ? { status: options.status } : {}),
      },
      include: {
        customer: true,
        items: { orderBy: { position: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        shipments: { orderBy: { shippedAt: 'desc' } },
        disputes: { select: { paypalDisputeId: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 100, 500),
    });
  }

  /**
   * Orders matching structured filters, with a database count and per-currency totals, for
   * questions like "Which orders haven't been paid?" or "How many orders came in today?".
   */
  async find(merchant: Pick<Merchant, 'id' | 'timezone'>, filter: OrderFilter, now = new Date()) {
    const range = filter.period ? resolvePeriod(filter.period, now, merchant.timezone) : null;
    const where = {
      merchantId: merchant.id,
      ...NOT_OPEN_CART,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.inputMode ? { inputMode: filter.inputMode } : {}),
      ...(filter.fulfillment ? { fulfillmentStatus: filter.fulfillment } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.customer
        ? { customer: { name: { contains: filter.customer.trim(), mode: 'insensitive' as const } } }
        : {}),
      ...(range
        ? { createdAt: { ...(range.start ? { gte: range.start } : {}), lt: range.end } }
        : {}),
    };
    const [count, totals, orders] = await Promise.all([
      this.db.order.count({ where }),
      this.db.order.groupBy({
        by: ['currency'],
        where,
        _sum: { totalMinor: true },
      }),
      this.db.order.findMany({
        where,
        include: { customer: { select: { name: true } }, items: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filter.limit ?? 10, 50),
      }),
    ]);
    return {
      period: range?.label ?? null,
      count,
      total: totals.map((t) => formatMoney(t._sum.totalMinor ?? 0, t.currency)),
      orders,
    };
  }

  async getByReference(merchantId: string, referenceOrId: string, tx: DatabaseTx = this.db) {
    const ref = referenceOrId.trim();
    const order = await tx.order.findFirst({
      where: { merchantId, OR: [{ reference: ref.toUpperCase() }, { id: ref }] },
      include: orderInclude,
    });
    if (!order) throw new NotFoundError('Order', ref);
    return order;
  }

  /**
   * Prices an AI command against the catalog WITHOUT writing anything. Prices come from the
   * catalog unless the merchant explicitly stated one; totals come exclusively from
   * `calculateOrderTotals`. Used for quotes and as the first step of `createDraft`.
   */
  async price(
    merchant: Pick<Merchant, 'id' | 'preferredCurrency'>,
    command: DraftOrderCommand,
    options: { strictCatalog?: boolean } = {},
  ): Promise<PricedCommand> {
    const currency = normalizeCurrency(command.currency ?? merchant.preferredCurrency);
    const warnings: string[] = [];

    const products = await this.db.product.findMany({
      where: { merchantId: merchant.id, active: true },
    });

    const lines: PricingLineInput[] = command.items.map((item) => {
      const product =
        (item.product_id && products.find((p) => p.id === item.product_id)) ||
        matchProduct(products, item.name);

      if (product && product.currency !== currency) {
        throw new ValidationError(
          `'${product.name}' is priced in ${product.currency} but the order is in ${currency}. Mixed currencies are not supported.`,
        );
      }
      const closest = product
        ? []
        : closestMatches(
            item.name,
            products.map((p) => p.name),
            1,
          );
      const hint = closest.length ? ` Closest catalog product: ${closest[0]}.` : '';
      if (!product && item.unit_price === undefined) {
        throw new ValidationError(
          `'${item.name}' is not in the catalog and no price was given.${hint} Ask the merchant which product they mean or for the unit price.`,
          { suggestions: closest },
        );
      }
      if (!product && options.strictCatalog && closest.length) {
        // A voice transcript may have misheard a catalog product ("buckets" for "baskets").
        // Never price a near-miss as a new item without the merchant saying which they meant.
        throw new ValidationError(
          `'${item.name}' isn't in the catalog. Did you mean ${closest[0]}? Ask the merchant to confirm the product.`,
          { suggestions: closest },
        );
      }
      if (!product) {
        warnings.push(
          `'${item.name}' isn't in your catalog${closest.length ? ` (closest: ${closest[0]})` : ''} — priced as stated.`,
        );
      }

      const unitPriceMinor =
        item.unit_price !== undefined
          ? toMinorUnits(item.unit_price, currency)
          : product!.unitPriceMinor;

      if (product && unitPriceMinor !== product.unitPriceMinor) {
        warnings.push(
          `${product.name}: using stated price ${formatMoney(unitPriceMinor, currency)} (catalog price ${formatMoney(product.unitPriceMinor, currency)}).`,
        );
      }
      if (product?.stockQuantity != null && item.quantity > product.stockQuantity) {
        warnings.push(
          `${product.name}: only ${product.stockQuantity} in stock, ${item.quantity} ordered.`,
        );
      }
      return {
        description: product?.name ?? item.name,
        quantity: item.quantity,
        unitPriceMinor,
        productId: product?.id ?? null,
      };
    });

    const totals = calculateOrderTotals({
      currency,
      lines,
      shippingMinor: command.shipping !== undefined ? toMinorUnits(command.shipping, currency) : 0,
      taxMinor: command.tax !== undefined ? toMinorUnits(command.tax, currency) : 0,
    });

    // The AI may have stated a total; we never use it, but we surface any disagreement.
    if (command.claimed_total !== undefined) {
      let claimedMinor: number | null;
      try {
        claimedMinor = toMinorUnits(command.claimed_total, currency);
      } catch {
        claimedMinor = null;
      }
      if (claimedMinor !== totals.totalMinor) {
        warnings.push(
          `The total mentioned (${command.claimed_total}) differs from the calculated total ${formatMoney(totals.totalMinor, currency)}. The calculated total is used.`,
        );
      }
    }
    return { totals, warnings };
  }

  /** Persists a priced command as a DRAFT order (resolving or creating the customer). */
  async createDraft(params: {
    merchant: Pick<Merchant, 'id' | 'preferredCurrency'>;
    command: DraftOrderCommand;
    source: string;
    conversationId?: string | null;
    /** How the merchant asked. VOICE: unknown customers are suggested, not created, and
     *  near-miss product names must be confirmed. */
    inputMode?: OrderInputMode;
  }): Promise<DraftOrderResult> {
    const { merchant, command } = params;
    const fromVoice = params.inputMode === 'VOICE';
    const { totals, warnings } = await this.price(merchant, command, { strictCatalog: fromVoice });
    const currency = totals.currency;

    const { orderId, isNew } = await this.db.$transaction(async (tx) => {
      const { customer, isNew } = await this.customers.resolveForOrder(
        merchant.id,
        command.customer,
        tx,
        { allowCreate: !fromVoice },
      );
      const order = await tx.order.create({
        data: {
          reference: generateOrderReference(),
          merchantId: merchant.id,
          customerId: customer.id,
          conversationId: params.conversationId ?? null,
          status: 'DRAFT',
          currency,
          subtotalMinor: totals.subtotalMinor,
          shippingMinor: totals.shippingMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          notes: command.notes ?? null,
          source: params.source,
          inputMode: params.inputMode ?? 'TEXT',
          items: {
            create: totals.lines.map((line, position) => ({
              description: line.description,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.lineTotalMinor,
              productId: line.productId ?? null,
              position,
            })),
          },
        },
      });
      await this.audit.record(
        {
          merchantId: merchant.id,
          actor: 'AGENT',
          type: 'order.drafted',
          entityType: 'order',
          entityId: order.id,
          data: {
            reference: order.reference,
            totalMinor: totals.totalMinor,
            currency,
            claimedTotal: command.claimed_total ?? null,
            warnings,
          },
        },
        tx,
      );
      return { orderId: order.id, isNew };
    });

    return {
      order: await this.getByReference(merchant.id, orderId),
      isNewCustomer: isNew,
      warnings,
    };
  }

  /** Status change guarded by the state machine and by optimistic concurrency on the old status. */
  async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    tx: DatabaseTx = this.db,
  ): Promise<boolean> {
    assertOrderTransition(from, to);
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to },
    });
    return count === 1;
  }
}
