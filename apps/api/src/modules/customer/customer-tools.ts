import { defineTool, ToolRegistry } from '@vca/ai';
import { toMinorUnits } from '@vca/commerce';
import type { Conversation, Customer, Merchant, WhatsAppAccount } from '@vca/database';
import { AppError, type OutboundMedia } from '@vca/shared';
import { z } from 'zod';
import type { BargainingService, BargainResult } from './bargaining.service';
import { CustomerCatalog } from './catalog';
import { ShopOrderService, type CheckoutStep, type ShopActor } from './shop-order.service';
import type { StorefrontService } from '../storefront/storefront.service';

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
  /**
   * Set by the bargaining tools: the amounts the reply may state, the shop's offer it must state,
   * and the backend's own wording to use if the reply doesn't pass that check.
   */
  bargain: { allowedMinor: number[]; keyMinor: number | null; message: string } | null;
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
async function friendly<T>(
  fn: () => Promise<T>,
  /** For cart changes: the shop's refusal is the reply, so the model can't claim a change. */
  cart?: CustomerAgentContext,
): Promise<T | { ok: false; message: string }> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof AppError) || error.httpStatus >= 500) throw error;
    if (cart) cart.verbatim = error.message;
    return { ok: false, message: error.message };
  }
}

/** What the model sees of a bargaining step: the decision, never the merchant's minimum. */
function bargainView(result: BargainResult) {
  return {
    status: result.status,
    product: result.product,
    quantity: result.quantity,
    regular_price: result.regularPrice,
    offer_price: result.offerPrice,
    final_offer: result.final ?? false,
    suggested_reply: result.message,
  };
}

function noteBargain(ctx: CustomerAgentContext, results: BargainResult[]) {
  const previous = ctx.bargain;
  ctx.bargain = {
    allowedMinor: [...(previous?.allowedMinor ?? []), ...results.flatMap((r) => r.amountsMinor)],
    keyMinor: results.find((r) => r.keyMinor !== null)?.keyMinor ?? previous?.keyMinor ?? null,
    message: results.map((r) => r.message).join('\n\n'),
  };
}

export function createCustomerTools(
  catalog: CustomerCatalog,
  shop: ShopOrderService,
  bargaining?: BargainingService,
  storefront?: Pick<StorefrontService, 'link'>,
): ToolRegistry<CustomerAgentContext> {
  const registry = createShoppingTools(catalog, shop);
  if (storefront) registerCatalogueLink(registry, catalog, storefront);
  return bargaining ? registerBargainingTools(registry, catalog, shop, bargaining) : registry;
}

/** Links to the public website catalogue, built by the backend so the model can't invent one. */
function registerCatalogueLink(
  registry: ToolRegistry<CustomerAgentContext>,
  catalog: CustomerCatalog,
  storefront: Pick<StorefrontService, 'link'>,
) {
  registry.register(
    defineTool({
      name: 'catalogue_link',
      kind: 'read',
      description:
        'A link to the shop’s website catalogue with photos: the whole shop, one product (name, list number or "this") or one category. ' +
        'Use when the customer wants to see many products or asks for a link. Share the link exactly as returned.',
      input: z.object({
        product: z.string().trim().min(1).max(100).optional(),
        category: z.string().trim().min(1).max(60).optional(),
      }),
      async execute({ product, category }, ctx) {
        const found = product ? await resolveProduct(catalog, ctx, product) : null;
        if (product && !found) return { found: false, note: 'No such product.' };
        const link = await storefront.link(ctx.merchant.id, {
          ...(found ? { productId: found.id } : {}),
          ...(category && !found ? { category } : {}),
        });
        return link
          ? {
              found: true,
              link,
              next: 'They can add items to a cart there and tap Checkout on WhatsApp to continue here.',
            }
          : { found: false, note: 'The shop has no website catalogue. Keep helping here.' };
      },
    }),
  );
}

function createShoppingTools(
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
              price_open_to_offers: p.negotiable,
              quantity_deals: p.deals,
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
            price_open_to_offers: found.negotiable,
            quantity_deals: found.deals,
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
          // Any size is accepted here so the shop's own limit message reaches the customer
          // (a schema error made the model invent a capped cart instead).
          quantity: z.number().int().min(1).max(100_000).default(1),
        }),
        async execute({ product, quantity }, ctx) {
          const found = await resolveProduct(catalog, ctx, product);
          if (!found)
            return { ok: false, message: 'No such product. Offer to show the product list.' };
          return friendly(async () => {
            const added = await shop.add(actorOf(ctx), found.id, quantity);
            ctx.lastProductId = found.id;
            // The cart the customer sees is built by the backend, never retold by the model.
            ctx.verbatim = `✅ Added: ${found.name} (now ${added.quantity} in your cart).\n\n${ShopOrderService.formatCart(added.cart)}`;
            return {
              ok: true,
              added: found.name,
              quantity_in_cart: added.quantity,
              cart: ShopOrderService.formatCart(added.cart),
              next: 'Show the cart text as is. The customer can reply *checkout* when ready.',
            };
          }, ctx);
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
          quantity: z.number().int().min(0).max(100_000),
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
            ctx.verbatim = ShopOrderService.formatCart(result.cart);
            return { ok: true, cart: ctx.verbatim };
          }, ctx);
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
          'Hand the conversation to the shop’s team: the customer asks for a person, has a complaint, wants a quantity ' +
          'too large for WhatsApp, or asks something the tools can’t answer. (Price bargaining: use negotiate_price.)',
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

/**
 * Bargaining. The model decides WHEN to bargain and passes the customer's own words (their price,
 * quantity); the backend decides every price. The model may phrase the reply, but the service
 * checks it against these results before it is sent (see price-guard.ts).
 */
function registerBargainingTools(
  registry: ToolRegistry<CustomerAgentContext>,
  catalog: CustomerCatalog,
  shop: ShopOrderService,
  bargaining: BargainingService,
): ToolRegistry<CustomerAgentContext> {
  /** The products a request is about: the one named, or the bargainable ones in the cart. */
  const targets = async (ctx: CustomerAgentContext, product: string | undefined) => {
    if (product) {
      const found = await resolveProduct(catalog, ctx, product);
      return found ? [found.id] : null;
    }
    const cart = await shop.cart(ctx.merchant.id, ctx.customer.id);
    const inCart = (cart?.items ?? []).map((i) => i.productId).filter((id): id is string => !!id);
    if (inCart.length) return inCart;
    return ctx.lastProductId ? [ctx.lastProductId] : [];
  };

  return registry
    .register(
      defineTool({
        name: 'negotiate_price',
        kind: 'read',
        description:
          'Use ONLY when the customer asks for a discount or a better price, or proposes a lower price ("can you do $25?", "last price?", "$50 for two"). ' +
          'product: the product name, its number from the last list, or "this"; omit it to bargain on everything in the cart. ' +
          'offer_price: the price the customer proposed, exactly as they said it (major units), if they named one; price_is_for: "each" or "total". ' +
          'quantity: units they want, if they said. The shop decides the offer; reply with the offer_price from the result (or use suggested_reply). ' +
          'Never propose, promise or invent any other price.',
        input: z.object({
          product: z.string().trim().min(1).max(100).optional(),
          offer_price: z.number().positive().max(10_000_000).optional(),
          price_is_for: z.enum(['each', 'total']).default('each'),
          quantity: z.number().int().min(1).max(100_000).optional(),
        }),
        async execute({ product, offer_price, price_is_for, quantity }, ctx) {
          const ids = await targets(ctx, product);
          if (ids === null)
            return { ok: false, message: 'No such product. Offer to show the product list.' };
          if (!ids.length)
            return {
              ok: false,
              message: 'Ask which product they would like a better price on (or show the list).',
            };
          if (offer_price !== undefined && ids.length > 1)
            return {
              ok: false,
              message:
                'The cart has several products: ask which product that price is for (prices are per product).',
            };
          let offered: number | null = null;
          if (offer_price !== undefined)
            try {
              offered = toMinorUnits(offer_price, ctx.merchant.preferredCurrency);
            } catch {
              offered = null;
            }
          const actor = actorOf(ctx);
          const results: BargainResult[] = [];
          for (const id of ids.slice(0, 5))
            results.push(
              await bargaining.ask(actor, id, {
                quantity: quantity ?? null,
                customerUnitMinor: price_is_for === 'each' ? offered : null,
                customerTotalMinor: price_is_for === 'total' ? offered : null,
              }),
            );
          noteBargain(ctx, results);
          // An agreed price changed the cart: the cart is shown exactly as the backend built it.
          const agreed = results.find((r) => r.status === 'agreed');
          if (agreed) ctx.verbatim = agreed.message;
          return results.length === 1
            ? bargainView(results[0]!)
            : { products: results.map(bargainView) };
        },
      }),
    )
    .register(
      defineTool({
        name: 'accept_offer',
        kind: 'read',
        description:
          'The customer accepts the price the shop offered ("ok", "deal", "I’ll take it at $28"). Puts the product in the cart at the agreed price. ' +
          'product: optional, when several offers are open.',
        input: z.object({ product: z.string().trim().min(1).max(100).optional() }),
        async execute({ product }, ctx) {
          const found = product ? await resolveProduct(catalog, ctx, product) : null;
          const result = await bargaining.accept(actorOf(ctx), { productId: found?.id ?? null });
          noteBargain(ctx, [result]);
          ctx.verbatim = result.message;
          return bargainView(result);
        },
      }),
    )
    .register(
      defineTool({
        name: 'decline_offer',
        kind: 'read',
        description:
          'The customer clearly refuses the shop’s offer WITHOUT naming a new price, or wants the regular price ("no deal", "forget the discount"). ' +
          'If they name a price, use negotiate_price instead. product: optional.',
        input: z.object({ product: z.string().trim().min(1).max(100).optional() }),
        async execute({ product }, ctx) {
          const found = product ? await resolveProduct(catalog, ctx, product) : null;
          const result = await bargaining.decline(actorOf(ctx), found?.id ?? null);
          noteBargain(ctx, [result]);
          ctx.verbatim = result.message;
          return bargainView(result);
        },
      }),
    );
}
