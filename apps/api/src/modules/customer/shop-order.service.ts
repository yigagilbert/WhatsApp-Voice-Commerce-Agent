import { createHash } from 'node:crypto';
import {
  calculateOrderTotals,
  formatMoney,
  generateOrderReference,
  type AuditService,
  type OrderService,
} from '@vca/commerce';
import type {
  Customer,
  Database,
  DatabaseTx,
  Merchant,
  Order,
  OrderItem,
  WhatsAppAccount,
} from '@vca/database';
import {
  AppError,
  ConflictError,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  type Logger,
} from '@vca/shared';
import { carrierDisplay } from '../shipments/shipment.service';
import type { NotificationService } from '../notifications/notification.service';
import type { PaymentService } from '../payments/payment.service';

const HOUR = 3_600_000;
export const CART_TTL_HOURS = 48;
/** Unpaid customer orders (placed, not yet paid) a customer may have open at once. */
export const MAX_UNPAID_ORDERS = 3;
export const MAX_CART_LINES = 15;
export const MAX_LINE_QUANTITY = 20;
const DEFAULT_NAME = 'WhatsApp customer';

type Cart = Order & { items: (OrderItem & { product: { name: string } | null })[] };
type Account = WhatsAppAccount & { merchant: Merchant };

export interface ShopActor {
  merchant: Pick<Merchant, 'id' | 'businessName'>;
  customer: Customer;
  conversationId: string;
}

/** Where the customer is in checkout (stored in Conversation.context.shop). */
export type CheckoutStep = 'name' | 'method' | 'address' | 'confirm';

export type PlaceResult =
  | { status: 'link'; reference: string; total: string; link: string }
  | { status: 'awaiting_approval'; reference: string; total: string }
  | { status: 'already'; reference: string; link: string | null }
  | { status: 'paid'; reference: string }
  | { status: 'changed'; summary: string; quote: string }
  | { status: 'expired' }
  | { status: 'paypal_failed'; reference: string }
  | { status: 'refused'; reason: string };

/** Orders that hold stock until paid or cancelled: placed by the customer or awaiting payment. */
const RESERVING = {
  OR: [
    { status: 'AWAITING_PAYMENT' as const },
    { status: 'DRAFT' as const, customerConfirmedAt: { not: null } },
  ],
};

/**
 * Customer carts, checkout and order status on WhatsApp. A cart is simply an Order in DRAFT
 * placed by the customer; ordering confirms it and reuses the merchant's PayPal checkout,
 * webhooks, reminders and stock ledger. Prices, totals and availability always come from the
 * database; the AI never supplies amounts and can't place an order (only the customer's ORDER
 * reply does).
 */
export class ShopOrderService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly payments: PaymentService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {}

  // ─── Cart ───────────────────────────────────────────────────────────────

  /** The customer's open cart (expired carts are cancelled on the way). */
  async cart(merchantId: string, customerId: string, now = new Date()): Promise<Cart | null> {
    await this.db.order.updateMany({
      where: {
        merchantId,
        customerId,
        placedBy: 'CUSTOMER',
        status: 'DRAFT',
        customerConfirmedAt: null,
        expiresAt: { lt: now },
      },
      data: { status: 'CANCELLED' },
    });
    return this.db.order.findFirst({
      where: {
        merchantId,
        customerId,
        placedBy: 'CUSTOMER',
        status: 'DRAFT',
        customerConfirmedAt: null,
      },
      include: {
        items: { orderBy: { position: 'asc' }, include: { product: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Units of a product the shop can still promise (stock minus unpaid orders). */
  async available(productId: string, excludeOrderId?: string, tx: DatabaseTx = this.db) {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
    if (product.stockQuantity === null) return Number.POSITIVE_INFINITY;
    const reserved = await tx.orderItem.aggregate({
      where: {
        productId,
        order: { ...RESERVING, ...(excludeOrderId ? { NOT: { id: excludeOrderId } } : {}) },
      },
      _sum: { quantity: true },
    });
    return product.stockQuantity - (reserved._sum.quantity ?? 0);
  }

  private async unpaidOrders(merchantId: string, customerId: string, tx: DatabaseTx = this.db) {
    return tx.order.count({
      where: { merchantId, customerId, placedBy: 'CUSTOMER', ...RESERVING },
    });
  }

  private assertStock(name: string, wanted: number, available: number) {
    if (available >= wanted) return;
    throw new ConflictError(
      available <= 0
        ? `Sorry, ${name} is out of stock right now.`
        : `Sorry, we can't offer that many ${name} right now. Please choose a smaller quantity.`,
    );
  }

  /** Adds `quantity` of a product (the shop's own, visible and active) to the cart. */
  async add(actor: ShopActor, productId: string, quantity: number, now = new Date()) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY)
      throw new ValidationError(`Please choose a quantity between 1 and ${MAX_LINE_QUANTITY}.`);
    const product = await this.db.product.findFirst({
      where: {
        id: productId,
        merchantId: actor.merchant.id,
        active: true,
        visibleToCustomers: true,
      },
    });
    if (!product) throw new NotFoundError('Product', productId);

    let cart = await this.cart(actor.merchant.id, actor.customer.id, now);
    if (!cart) {
      if ((await this.unpaidOrders(actor.merchant.id, actor.customer.id)) >= MAX_UNPAID_ORDERS)
        throw new ConflictError(
          `You have ${MAX_UNPAID_ORDERS} unpaid orders. Please pay one (reply *orders*) or ask us for help before starting a new one.`,
        );
      const created = await this.db.order.create({
        data: {
          reference: generateOrderReference(),
          merchantId: actor.merchant.id,
          customerId: actor.customer.id,
          conversationId: actor.conversationId,
          status: 'DRAFT',
          placedBy: 'CUSTOMER',
          currency: product.currency,
          subtotalMinor: 0,
          totalMinor: 0,
          source: 'whatsapp',
          expiresAt: new Date(now.getTime() + CART_TTL_HOURS * HOUR),
        },
      });
      cart = { ...created, items: [] };
    }
    if (cart.currency !== product.currency)
      throw new ValidationError(
        `${product.name} is priced in ${product.currency}; your cart is in ${cart.currency}. Please order it separately.`,
      );
    const line = cart.items.find((i) => i.productId === product.id);
    const wanted = (line?.quantity ?? 0) + quantity;
    if (wanted > MAX_LINE_QUANTITY)
      throw new ValidationError(
        `You can order up to ${MAX_LINE_QUANTITY} of one product here. For more, ask to talk to a person.`,
      );
    if (!line && cart.items.length >= MAX_CART_LINES)
      throw new ValidationError(`Your cart can hold ${MAX_CART_LINES} different products.`);
    this.assertStock(product.name, wanted, await this.available(product.id, cart.id));

    await this.db.$transaction(async (tx) => {
      if (line)
        await tx.orderItem.update({
          where: { id: line.id },
          data: { quantity: wanted, unitPriceMinor: product.unitPriceMinor },
        });
      else
        await tx.orderItem.create({
          data: {
            orderId: cart.id,
            productId: product.id,
            description: product.name,
            quantity,
            unitPriceMinor: product.unitPriceMinor,
            lineTotalMinor: product.unitPriceMinor * quantity,
            position: cart.items.length,
          },
        });
      await this.recompute(tx, cart.id, 0, now);
    });
    return {
      product: product.name,
      quantity: wanted,
      cart: (await this.cart(actor.merchant.id, actor.customer.id, now))!,
    };
  }

  /** Sets the quantity of cart line `line` (1-based) or of a product; 0 removes it. */
  async setQuantity(
    actor: ShopActor,
    target: { line?: number; productId?: string },
    quantity: number,
    now = new Date(),
  ) {
    const cart = await this.cart(actor.merchant.id, actor.customer.id, now);
    if (!cart || !cart.items.length) throw new ConflictError('Your cart is empty.');
    const item =
      target.line !== undefined
        ? cart.items[target.line - 1]
        : cart.items.find((i) => i.productId === target.productId);
    if (!item)
      throw new ValidationError(
        target.line !== undefined
          ? `Your cart has ${cart.items.length} item${cart.items.length === 1 ? '' : 's'}. Reply *cart* to see them.`
          : "That product isn't in your cart.",
      );
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_LINE_QUANTITY)
      throw new ValidationError(`Please choose a quantity between 0 and ${MAX_LINE_QUANTITY}.`);
    if (quantity > 0 && item.productId)
      this.assertStock(item.description, quantity, await this.available(item.productId, cart.id));
    await this.db.$transaction(async (tx) => {
      if (quantity === 0) await tx.orderItem.delete({ where: { id: item.id } });
      else await tx.orderItem.update({ where: { id: item.id }, data: { quantity } });
      await this.recompute(tx, cart.id, 0, now);
    });
    return {
      product: item.description,
      quantity,
      cart: await this.cart(actor.merchant.id, actor.customer.id, now),
    };
  }

  async clear(actor: ShopActor) {
    const cart = await this.cart(actor.merchant.id, actor.customer.id);
    if (cart) await this.orders.transition(cart.id, 'DRAFT', 'CANCELLED');
  }

  /** Totals from the lines (backend arithmetic only); an emptied cart is cancelled. */
  private async recompute(tx: DatabaseTx, orderId: string, shippingMinor: number, now: Date) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!order.items.length) {
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED', subtotalMinor: 0, totalMinor: 0 },
      });
      return;
    }
    const totals = calculateOrderTotals({
      currency: order.currency,
      lines: order.items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        productId: i.productId,
      })),
      shippingMinor,
    });
    for (const [index, line] of totals.lines.entries()) {
      await tx.orderItem.update({
        where: { id: order.items[index]!.id },
        data: { lineTotalMinor: line.lineTotalMinor, position: index },
      });
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotalMinor: totals.subtotalMinor,
        shippingMinor: totals.shippingMinor,
        totalMinor: totals.totalMinor,
        ...(order.customerConfirmedAt
          ? {}
          : { expiresAt: new Date(now.getTime() + CART_TTL_HOURS * HOUR) }),
      },
    });
  }

  static formatCart(cart: Cart | null): string {
    if (!cart || !cart.items.length)
      return 'Your cart is empty. Reply *1* to browse products, or tell me what you need.';
    return [
      '*Your cart*',
      ...cart.items.map(
        (i, n) =>
          `${n + 1}. ${i.product?.name ?? i.description} × ${i.quantity} — ${formatMoney(i.unitPriceMinor * i.quantity, cart.currency)}`,
      ),
      `Subtotal: *${formatMoney(cart.subtotalMinor, cart.currency)}*`,
      '',
      'Reply *checkout* to order, *remove 1* to remove an item, or keep browsing (*1*).',
    ].join('\n');
  }

  // ─── Checkout ───────────────────────────────────────────────────────────

  /**
   * Re-checks the cart against the catalog (prices, visibility, stock) and returns it with what
   * changed. Unavailable products are removed; changed prices are updated.
   */
  private async refresh(actor: ShopActor, now = new Date()) {
    const cart = await this.cart(actor.merchant.id, actor.customer.id, now);
    if (!cart || !cart.items.length) return { cart: null, notes: [] as string[] };
    const notes: string[] = [];
    await this.db.$transaction(async (tx) => {
      for (const item of cart.items) {
        const product = item.productId
          ? await tx.product.findFirst({
              where: {
                id: item.productId,
                merchantId: actor.merchant.id,
                active: true,
                visibleToCustomers: true,
              },
            })
          : null;
        if (!product) {
          await tx.orderItem.delete({ where: { id: item.id } });
          notes.push(`${item.description} is no longer available and was removed.`);
        } else if (product.unitPriceMinor !== item.unitPriceMinor) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: { unitPriceMinor: product.unitPriceMinor },
          });
          notes.push(
            `${product.name} is now ${formatMoney(product.unitPriceMinor, product.currency)} (was ${formatMoney(item.unitPriceMinor, cart.currency)}).`,
          );
        }
      }
      await this.recompute(tx, cart.id, 0, now);
    });
    const fresh = await this.cart(actor.merchant.id, actor.customer.id, now);
    for (const item of fresh?.items ?? []) {
      if (!item.productId) continue;
      const available = await this.available(item.productId, fresh!.id);
      if (available < item.quantity)
        notes.push(
          available <= 0
            ? `${item.description} is out of stock. Reply *remove ${fresh!.items.indexOf(item) + 1}* to continue.`
            : `We can't offer ${item.quantity} ${item.description} right now. Please reduce the quantity.`,
        );
    }
    return { cart: fresh, notes };
  }

  /** The next thing checkout needs from the customer, and the prompt for it. */
  async nextStep(
    actor: ShopActor,
    account: Account,
  ): Promise<{ step: CheckoutStep | null; text: string; quote?: string; orderId?: string }> {
    const { cart, notes } = await this.refresh(actor);
    if (!cart)
      return { step: null, text: [...notes, ShopOrderService.formatCart(null)].join('\n\n') };
    const blocking = notes.filter((n) => /out of stock|can't offer/.test(n));
    if (blocking.length)
      return { step: null, text: [...notes, ShopOrderService.formatCart(cart)].join('\n\n') };
    const prefix = notes.length ? `${notes.join('\n')}\n\n` : '';

    if (!cart.contactName) {
      if (actor.customer.name === DEFAULT_NAME)
        return {
          step: 'name',
          text: `${prefix}What name should we put on your order?`,
          orderId: cart.id,
        };
      await this.db.order.update({
        where: { id: cart.id },
        data: { contactName: actor.customer.name },
      });
      cart.contactName = actor.customer.name;
    }
    const methods = [
      account.deliveryEnabled ? 'DELIVERY' : null,
      account.pickupEnabled ? 'PICKUP' : null,
    ].filter(Boolean) as ('DELIVERY' | 'PICKUP')[];
    if (!cart.deliveryMethod && methods.length === 1) {
      await this.db.order.update({ where: { id: cart.id }, data: { deliveryMethod: methods[0]! } });
      cart.deliveryMethod = methods[0]!;
    }
    if (!cart.deliveryMethod && methods.length === 2)
      return {
        step: 'method',
        orderId: cart.id,
        text: `${prefix}How would you like to get your order?\n*1* Delivery (${formatMoney(account.deliveryFeeMinor, cart.currency)})\n*2* Pick up${account.pickupInfo ? ` — ${account.pickupInfo}` : ''}`,
      };
    if (cart.deliveryMethod === 'DELIVERY' && !cart.deliveryAddress)
      return {
        step: 'address',
        orderId: cart.id,
        text: `${prefix}Where should we deliver? Please send your full address (area, street, landmark).`,
      };
    const summary = await this.summary(cart.id, account);
    return {
      step: 'confirm',
      orderId: cart.id,
      text: `${prefix}${summary.text}`,
      quote: summary.quote,
    };
  }

  /** Records the customer's answer for a checkout step. Returns an error message or null. */
  async answer(
    actor: ShopActor,
    orderId: string,
    step: CheckoutStep,
    text: string,
  ): Promise<string | null> {
    const order = await this.db.order.findFirst({
      where: {
        id: orderId,
        merchantId: actor.merchant.id,
        customerId: actor.customer.id,
        status: 'DRAFT',
        customerConfirmedAt: null,
      },
    });
    if (!order) return 'Your cart has changed. Reply *cart* to see it.';
    const clean = text
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (step === 'name') {
      if (clean.length < 2 || clean.length > 60 || /\d{4,}/.test(clean))
        return 'Please send just your name (2–60 letters).';
      await this.db.order.update({ where: { id: orderId }, data: { contactName: clean } });
      if (actor.customer.source === 'WHATSAPP' && actor.customer.name === DEFAULT_NAME)
        await this.db.customer.update({ where: { id: actor.customer.id }, data: { name: clean } });
      return null;
    }
    if (step === 'method') {
      const method = /^(1|delivery|deliver)\b/i.test(clean)
        ? 'DELIVERY'
        : /^(2|pick ?up|collect)/i.test(clean)
          ? 'PICKUP'
          : null;
      if (!method) return 'Please reply *1* for delivery or *2* to pick up.';
      await this.db.order.update({ where: { id: orderId }, data: { deliveryMethod: method } });
      return null;
    }
    if (step === 'address') {
      if (clean.length < 8 || clean.length > 300)
        return 'Please send your full delivery address (area, street, landmark).';
      await this.db.order.update({ where: { id: orderId }, data: { deliveryAddress: clean } });
      return null;
    }
    return null;
  }

  /** The exact order summary the customer confirms, and a fingerprint of it. */
  async summary(orderId: string, account: Account, tx: DatabaseTx = this.db) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    const fee = order.deliveryMethod === 'DELIVERY' ? account.deliveryFeeMinor : 0;
    const totals = calculateOrderTotals({
      currency: order.currency,
      lines: order.items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        productId: i.productId,
      })),
      shippingMinor: fee,
    });
    const money = (m: number) => formatMoney(m, order.currency);
    const text = [
      '*Order summary*',
      ...order.items.map(
        (i) => `• ${i.description} × ${i.quantity} — ${money(i.unitPriceMinor * i.quantity)}`,
      ),
      `Subtotal: ${money(totals.subtotalMinor)}`,
      ...(order.deliveryMethod === 'DELIVERY'
        ? [`Delivery: ${money(fee)} to ${order.deliveryAddress}`]
        : order.deliveryMethod === 'PICKUP'
          ? [`Pick up${account.pickupInfo ? `: ${account.pickupInfo}` : ''} (free)`]
          : []),
      `*Total: ${money(totals.totalMinor)}*`,
      `Name: ${order.contactName}`,
      '',
      account.paymentLinkMode === 'AUTO'
        ? 'Reply *ORDER* to place your order and get a secure PayPal payment link, or *cart* to make changes.'
        : 'Reply *ORDER* to place your order. The shop will confirm it and send a secure PayPal payment link. Reply *cart* to make changes.',
    ].join('\n');
    const quote = createHash('sha256')
      .update(
        JSON.stringify([
          order.items.map((i) => [i.productId, i.quantity, i.unitPriceMinor]),
          fee,
          totals.totalMinor,
          order.deliveryMethod,
          order.deliveryAddress,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    return { text, quote, totals };
  }

  /**
   * The customer replied ORDER. Serialised per merchant (advisory lock) so concurrent checkouts
   * can't oversell the last items and a repeated ORDER never creates a second order or link.
   */
  async place(
    actor: ShopActor,
    account: Account,
    orderId: string,
    quote: string | null,
  ): Promise<PlaceResult> {
    const merchantId = actor.merchant.id;
    const result = await this.db.$transaction(
      async (
        tx,
      ): Promise<
        | PlaceResult
        | { status: 'confirmed'; order: Order; fresh: boolean; paymentKey: string | null }
      > => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`checkout:${merchantId}`}))`;
        const order = await tx.order.findFirst({
          where: { id: orderId, merchantId, customerId: actor.customer.id, placedBy: 'CUSTOMER' },
          include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
        });
        if (!order || order.status === 'CANCELLED') return { status: 'expired' };
        if (order.status === 'PAID') return { status: 'paid', reference: order.reference };
        if (order.status === 'AWAITING_PAYMENT')
          return {
            status: 'already',
            reference: order.reference,
            link: order.payments[0]?.checkoutUrl ?? null,
          };
        if (order.status !== 'DRAFT') return { status: 'expired' };
        if (order.customerConfirmedAt) return this.claim(tx, account, order, false);
        if (order.expiresAt && order.expiresAt < new Date()) return { status: 'expired' };

        // What the customer saw must still be exactly true. Bring the cart up to the catalog's
        // current prices, then compare with the summary they confirmed: any difference means
        // they see the new summary and confirm again.
        const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
        for (const item of items) {
          if (!item.productId) continue;
          const product = await tx.product.findFirst({
            where: { id: item.productId, merchantId, active: true, visibleToCustomers: true },
          });
          if (!product)
            return {
              status: 'refused',
              reason: `Sorry, ${item.description} is no longer available. Reply *cart* to change your order.`,
            };
          if (product.unitPriceMinor !== item.unitPriceMinor)
            await tx.orderItem.update({
              where: { id: item.id },
              data: { unitPriceMinor: product.unitPriceMinor },
            });
        }
        await this.recompute(tx, order.id, 0, new Date());
        const current = await this.summary(order.id, account, tx);
        if (!quote || current.quote !== quote)
          return { status: 'changed', summary: current.text, quote: current.quote };
        for (const item of items) {
          if (!item.productId) continue;
          const available = await this.available(item.productId, order.id, tx);
          if (available < item.quantity)
            return {
              status: 'refused',
              reason: `Sorry, ${item.description} just sold out or is short. Reply *cart* to change your order.`,
            };
        }
        if ((await this.unpaidOrders(merchantId, actor.customer.id, tx)) >= MAX_UNPAID_ORDERS)
          return {
            status: 'refused',
            reason: `You already have ${MAX_UNPAID_ORDERS} unpaid orders. Please pay one first (reply *orders*).`,
          };
        const fee = order.deliveryMethod === 'DELIVERY' ? account.deliveryFeeMinor : 0;
        await this.recompute(tx, order.id, fee, new Date());
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: 'DRAFT', customerConfirmedAt: null },
          data: { customerConfirmedAt: new Date(), expiresAt: null },
        });
        if (claimed.count !== 1) return { status: 'expired' };
        await this.audit.record(
          {
            merchantId,
            actor: 'SYSTEM',
            type: 'order.placed_by_customer',
            entityType: 'order',
            entityId: order.id,
            data: {
              reference: order.reference,
              totalMinor: current.totals.totalMinor,
              currency: order.currency,
              mode: account.paymentLinkMode,
            },
          },
          tx,
        );
        return this.claim(
          tx,
          account,
          await tx.order.findUniqueOrThrow({ where: { id: order.id } }),
          true,
        );
      },
      { timeout: 30_000 },
    );
    if (result.status !== 'confirmed') return result;

    const order = result.order;
    const total = formatMoney(order.totalMinor, order.currency);
    if (account.paymentLinkMode === 'APPROVAL') {
      if (result.fresh)
        await this.notifyNewOrder(
          merchantId,
          order.id,
          `Reply *request payment for ${order.reference}* to approve it and send the PayPal link.`,
        );
      return { status: 'awaiting_approval', reference: order.reference, total };
    }
    if (!result.paymentKey) return { status: 'already', reference: order.reference, link: null };
    return this.sendPaymentLink(actor.merchant, order.id, result.fresh, result.paymentKey);
  }

  /**
   * Inside the checkout lock: reserves the next PayPal attempt for a placed order (a placeholder
   * Payment row that createCheckout then completes), so a concurrent duplicate ORDER sees the
   * attempt in flight and creates nothing. A stuck attempt (e.g. a crash) is retried after 2 min.
   */
  private async claim(tx: DatabaseTx, account: Account, order: Order, fresh: boolean) {
    const confirmed = { status: 'confirmed' as const, order, fresh };
    if (account.paymentLinkMode === 'APPROVAL') return { ...confirmed, paymentKey: null };
    const latest = await tx.payment.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    if (latest && (latest.status === 'CREATED' || latest.status === 'APPROVED')) {
      if (latest.checkoutUrl || Date.now() - latest.createdAt.getTime() < 2 * 60_000)
        return { ...confirmed, paymentKey: null };
      await tx.payment.update({ where: { id: latest.id }, data: { status: 'FAILED' } });
    }
    const paymentKey = `customer-order-${order.id}-${await tx.payment.count({ where: { orderId: order.id } })}`;
    await tx.payment.create({
      data: {
        merchantId: order.merchantId,
        orderId: order.id,
        provider: 'PAYPAL',
        kind: 'CHECKOUT_ORDER',
        status: 'CREATED',
        amountMinor: order.totalMinor,
        currency: order.currency,
        idempotencyKey: paymentKey,
      },
    });
    return { ...confirmed, paymentKey };
  }

  /** Creates the PayPal checkout for a placed order (idempotent per attempt). */
  private async sendPaymentLink(
    merchant: ShopActor['merchant'],
    orderId: string,
    fresh: boolean,
    paymentKey: string,
  ): Promise<PlaceResult> {
    const order = await this.orders.getByReference(merchant.id, orderId);
    try {
      const payment = await this.payments.createCheckout(order, paymentKey);
      if (fresh)
        await this.notifyNewOrder(
          merchant.id,
          orderId,
          'The PayPal payment link was sent to the customer.',
        );
      return {
        status: 'link',
        reference: order.reference,
        total: formatMoney(order.totalMinor, order.currency),
        link: payment.checkoutUrl!,
      };
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        await this.db.order.update({ where: { id: orderId }, data: { customerConfirmedAt: null } });
        return {
          status: 'refused',
          reason:
            'This order is above what we can take on WhatsApp. Reply *4* to talk to a person.',
        };
      }
      if (error instanceof AppError && error.code.startsWith('PROVIDER')) {
        this.logger.warn({ err: error, orderId }, 'customer checkout: PayPal unavailable');
        if (fresh)
          await this.notifyNewOrder(
            merchant.id,
            orderId,
            '⚠️ PayPal could not create the payment link yet; the customer can retry.',
          );
        return { status: 'paypal_failed', reference: order.reference };
      }
      throw error;
    }
  }

  private async notifyNewOrder(merchantId: string, orderId: string, next: string) {
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, customer: true },
    });
    await this.notifications.toAdmins(
      merchantId,
      [
        `🛒 *New WhatsApp order ${order.reference}*`,
        `${order.contactName ?? order.customer.name} · ${formatMoney(order.totalMinor, order.currency)}`,
        ...order.items.map((i) => `• ${i.description} × ${i.quantity}`),
        order.deliveryMethod === 'DELIVERY'
          ? `Delivery to: ${order.deliveryAddress}`
          : order.deliveryMethod === 'PICKUP'
            ? 'Pick up'
            : '',
        '',
        next,
      ]
        .filter((l, i, all) => l !== '' || all[i - 1] !== '')
        .join('\n'),
    );
  }

  // ─── Order status ────────────────────────────────────────────────────────

  /** This customer's orders with this merchant (never anyone else's), newest first. */
  async myOrders(merchantId: string, customerId: string) {
    return this.db.order.findMany({
      where: {
        merchantId,
        customerId,
        NOT: { placedBy: 'CUSTOMER', status: 'DRAFT', customerConfirmedAt: null },
        status: { not: 'CANCELLED' },
      },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        shipments: { where: { status: 'SHIPPED' }, orderBy: { shippedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  }

  static formatOrders(orders: Awaited<ReturnType<ShopOrderService['myOrders']>>): string {
    if (!orders.length) return "You don't have any orders yet. Reply *1* to browse products.";
    return [
      '*Your orders*',
      ...orders.map((o) => {
        const total = formatMoney(o.totalMinor, o.currency);
        const shipment = o.shipments[0];
        const status =
          o.status === 'DRAFT'
            ? 'waiting for the shop to confirm'
            : o.status === 'AWAITING_PAYMENT'
              ? `waiting for payment${o.payments[0]?.checkoutUrl ? `\n  Pay here: ${o.payments[0].checkoutUrl}` : ''}`
              : o.status === 'PAID'
                ? shipment
                  ? `paid ✅ · shipped 🚚 ${carrierDisplay(shipment)} ${shipment.trackingNumber}`
                  : 'paid ✅ · being prepared'
                : o.status === 'REFUNDED'
                  ? 'refunded'
                  : o.status.toLowerCase();
        return `• ${o.reference} · ${total} · ${status}`;
      }),
      '',
      'Questions about an order? Reply *4* to talk to a person.',
    ].join('\n');
  }
}
