import { defineTool, ToolRegistry } from '@vca/ai';
import type { Conversation, Customer, Merchant, WhatsAppAccount } from '@vca/database';
import { AppError, type OutboundMedia } from '@vca/shared';
import { z } from 'zod';
import { CustomerCatalog } from './catalog';
import { ShopOrderService, type CheckoutStep, type ShopActor } from './shop-order.service';

/**
 * Everything a customer tool may touch. Built by the router from the bot account and the
 * identified customer — never from model arguments — so a tool can only read this merchant's
 * public catalog and act on this customer's own conversation.
 */
export interface CustomerAgentContext {
  merchant: Merchant;
  account: WhatsAppAccount;
  customer: Customer;
  conversation: Conversation;
  /** Product photos to send with the reply. */
  attachments: { media: OutboundMedia; caption: string }[];
  /** Product IDs of the last numbered list shown, so "2" means the second item. */
  shownList: string[] | null;
  /** The product shown last (details), so "add 2" / "remove this" know what "this" is. */
  lastProductId: string | null;
  /** Set by request_human; the service pauses automated replies and alerts the admins. */
  handoffReason: string | null;
  /** Backend-built text that must be the reply as is (checkout prompts and summaries). */
  verbatim: string | null;
  /** Checkout started by start_checkout. */
  checkout: { orderId: string; step: CheckoutStep; quote: string | null } | null;
}

/**
 * The customer agent's tools. Deliberately small and read-only (plus "talk to a person"): no
 * orders, payments, customers, stock counts, analytics or admin actions are reachable from a
 * customer conversation, whatever the model is told.
 */
/** Resolves "the basket", "3" (from the last list) or "this" to one of the shop's products. */
async function resolveProduct(catalog: CustomerCatalog, ctx: CustomerAgentContext, ref: string) {
  const n = /^\d{1,3}$/.test(ref.trim()) ? Number(ref) : null;
  const id =
    n && ctx.shownList
      ? ctx.shownList[n - 1]
      : /^(this|it|that|this one|that one)$/i.test(ref.trim())
        ? (ctx.lastProductId ?? undefined)
        : undefined;
  return catalog.find(ctx.merchant.id, id ?? ref);
}

const actorOf = (ctx: CustomerAgentContext): ShopActor => ({
  merchant: ctx.merchant,
  customer: ctx.customer,
  conversationId: ctx.conversation.id,
});

/** Cart rules (stock, limits) are explained to the customer, not thrown at the model. */
async function friendly<T>(fn: () => Promise<T>): Promise<T | { ok: false; message: string }> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError && error.httpStatus < 500)
      return { ok: false, message: error.message };
    throw error;
  }
}

export function createCustomerTools(
  catalog: CustomerCatalog,
  shop: ShopOrderService,
): ToolRegistry<CustomerAgentContext> {
  return new ToolRegistry<CustomerAgentContext>()
    .register(
      defineTool({
        name: 'browse_products',
        kind: 'read',
        description:
          'List or search the shop’s products with price and availability (In stock / Low stock / Out of stock). ' +
          'Use for "what do you sell?", "show me baskets", "do you have something for coffee?". Omit query to list everything.',
        input: z.object({
          query: z.string().trim().max(100).optional(),
          page: z.number().int().min(1).max(50).optional(),
        }),
        async execute({ query, page }, ctx) {
          const result = await catalog.search(ctx.merchant.id, query, page ?? 1);
          // Numbers in the list refer to the whole result, page after page.
          ctx.shownList = result.ids;
          return {
            total: result.total,
            page: result.page,
            pages: result.pages,
            numbered_list: CustomerCatalog.formatList(result),
            products: result.products.map((p) => ({
              name: p.name,
              price: p.price,
              availability: p.availability,
              description: p.description,
            })),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'product_details',
        kind: 'read',
        description:
          'Details of one product (price, availability, description) and its photo, which is sent to the customer automatically. ' +
          'Pass the product name, or the number from the last list shown.',
        input: z.object({ product: z.string().trim().min(1).max(100) }),
        async execute({ product }, ctx) {
          const n = /^\d{1,3}$/.test(product) ? Number(product) : null;
          const id = n && ctx.shownList ? ctx.shownList[n - 1] : undefined;
          const found = await catalog.find(ctx.merchant.id, id ?? product);
          if (!found)
            return { found: false, note: 'No such product. Offer to show the product list.' };
          ctx.lastProductId = found.id;
          const photo = found.hasPhoto ? await catalog.photo(ctx.merchant.id, found.id) : null;
          if (photo)
            ctx.attachments.push({ media: photo, caption: `${found.name} — ${found.price}` });
          return {
            found: true,
            name: found.name,
            price: found.price,
            availability: found.availability,
            description: found.description,
            photo_sent: !!photo,
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'shop_info',
        kind: 'read',
        description:
          'The shop’s own information for customers: opening hours, delivery, payment, returns, contact. ' +
          'Use for any question about how the shop works. If it doesn’t answer the question, offer a person.',
        input: z.object({}),
        async execute(_input, ctx) {
          return {
            business: ctx.merchant.businessName,
            info: ctx.account.shopInfo ?? null,
            payment: 'PayPal (secure checkout link)',
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'add_to_cart',
        kind: 'read',
        description:
          'Add a product to the customer’s cart. product: its name, its number from the last list, or "this" for the product just shown. ' +
          'Prices come from the shop; never state a price that the result doesn’t give.',
        input: z.object({
          product: z.string().trim().min(1).max(100),
          quantity: z.number().int().min(1).max(20).default(1),
        }),
        async execute({ product, quantity }, ctx) {
          const found = await resolveProduct(catalog, ctx, product);
          if (!found)
            return { ok: false, message: 'No such product. Offer to show the product list.' };
          return friendly(async () => {
            const added = await shop.add(actorOf(ctx), found.id, quantity);
            ctx.lastProductId = found.id;
            return {
              ok: true,
              added: found.name,
              quantity_in_cart: added.quantity,
              cart: ShopOrderService.formatCart(added.cart),
              next: 'Show the cart text as is. The customer can reply *checkout* when ready.',
            };
          });
        },
      }),
    )
    .register(
      defineTool({
        name: 'update_cart',
        kind: 'read',
        description:
          'Change the quantity of an item in the cart, or remove it (quantity 0). item: the cart line number, the product name, or "this".',
        input: z.object({
          item: z.string().trim().min(1).max(100),
          quantity: z.number().int().min(0).max(20),
        }),
        async execute({ item, quantity }, ctx) {
          return friendly(async () => {
            const line = /^\d{1,2}$/.test(item.trim()) ? Number(item) : undefined;
            const product = line === undefined ? await resolveProduct(catalog, ctx, item) : null;
            if (line === undefined && !product)
              return { ok: false, message: "That item isn't in the cart. Show the cart." };
            const result = await shop.setQuantity(
              actorOf(ctx),
              line !== undefined ? { line } : { productId: product!.id },
              quantity,
            );
            return { ok: true, cart: ShopOrderService.formatCart(result.cart) };
          });
        },
      }),
    )
    .register(
      defineTool({
        name: 'view_cart',
        kind: 'read',
        description: 'The customer’s cart with prices and subtotal (from the shop).',
        input: z.object({}),
        async execute(_input, ctx) {
          return {
            cart: ShopOrderService.formatCart(await shop.cart(ctx.merchant.id, ctx.customer.id)),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'start_checkout',
        kind: 'read',
        description:
          'Start checkout when the customer wants to order/pay for their cart. Shows the next question (name, delivery) or the order summary. ' +
          'Only the customer’s own reply "ORDER" places the order; you cannot place it.',
        input: z.object({}),
        async execute(_input, ctx) {
          const next = await shop.nextStep(actorOf(ctx), {
            ...ctx.account,
            merchant: ctx.merchant,
          });
          ctx.verbatim = next.text;
          ctx.checkout =
            next.step && next.orderId
              ? { orderId: next.orderId, step: next.step, quote: next.quote ?? null }
              : null;
          return { shown_to_customer: true };
        },
      }),
    )
    .register(
      defineTool({
        name: 'my_orders',
        kind: 'read',
        description:
          'This customer’s own orders with this shop and their status (waiting for payment with the payment link, paid, shipped with tracking). ' +
          'Use for "where is my order?", "did my payment go through?".',
        input: z.object({}),
        async execute(_input, ctx) {
          return {
            orders: ShopOrderService.formatOrders(
              await shop.myOrders(ctx.merchant.id, ctx.customer.id),
            ),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'request_human',
        kind: 'read',
        description:
          'Hand the conversation to the shop’s team: the customer asks for a person, wants to order or negotiate, ' +
          'has a complaint, or asks something the tools can’t answer.',
        input: z.object({ reason: z.string().trim().min(1).max(200) }),
        async execute({ reason }, ctx) {
          ctx.handoffReason = reason;
          return {
            status: 'team_notified',
            note: 'Tell the customer the team will reply here soon.',
          };
        },
      }),
    );
}
