import {
  chatModelReady,
  runAgent,
  type ChatMessage,
  type ChatModel,
  type ToolRegistry,
} from '@vca/ai';
import { chatIdToPhone, type AuditService, type IdentifiedCustomer } from '@vca/commerce';
import type { Conversation, Customer, Database, Merchant, WhatsAppAccount } from '@vca/database';
import {
  ConflictError,
  NotFoundError,
  getCorrelationId,
  isAppError,
  type InboundChannelMessage,
  type InboundProcessingResult,
  type Logger,
  type OutboundMedia,
} from '@vca/shared';
import type { NotificationService } from '../notifications/notification.service';
import type { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { CustomerCatalog } from './catalog';
import {
  ShopOrderService,
  formatLine,
  type CheckoutStep,
  type ShopActor,
} from './shop-order.service';
import type { BargainingService } from './bargaining.service';
import { CART_REFERENCE, type StorefrontService } from '../storefront/storefront.service';
import { buildCustomerPrompt } from './customer-prompt';
import type { CustomerAgentContext } from './customer-tools';
import { checkReplyPrices, moneyAmounts } from './price-guard';

const HOUR = 3_600_000;
const PER_MINUTE = 15;
const PER_DAY = 300;
const HISTORY_TURNS = 12;

const GREETING =
  /^(hi+|hello|hey|hallo|good (morning|afternoon|evening)|start|menu|help|0|hola|oli otya)[\s!.?]*$/i;
const HUMAN =
  /\b(human|real person|a person|someone|agent|staff|owner|manager|talk to (the )?(team|shop|seller))\b/i;
const MORE = /^(more|next|more please|next page)[\s!.?]*$/i;
const ORDER_WORD = /^order[\s!.]*$/i;
const CANCEL = /^(cancel|stop|back|no)[\s!.]*$/i;
const CART = /^(cart|my cart|basket|my basket|view cart|show (me )?(my )?cart)[\s!.?]*$/i;
const ORDERS =
  /^((my )?orders?( status)?|show (me )?my orders|where('?s| is) my order|track( my)? order|order status)[\s!.?]*$/i;
const CHECKOUT = /^(check ?out|place (my |an )?order|buy now|pay now)[\s!.]*$/i;
/** "add", "add 2", "add 2 of 3", "add 2 x product 3". */
const ADD =
  /^add(?:\s+(\d{1,2}))?(?:\s*(?:x|×|of|pcs?|pieces?)?\s*(?:product|item|number|no\.?|#)?\s*(\d{1,3}))?(?:\s+to (?:my )?cart)?[\s!.]*$/i;
/** "cancel ORD-ABC123" / "cancel order ORD-ABC123": the customer cancels their own unpaid order. */
const CANCEL_ORDER = /^cancel\s+(?:my\s+)?(?:order\s+)?(ORD-[A-Z0-9]{6})[\s!.]*$/i;
/** Accepting / refusing the shop's price offer, without the AI. */
const DEAL =
  /^(deal|it'?s a deal|accept|i accept|ok(ay)?,? deal|yes,? deal|deal done)[\s!.👍🤝]*$/iu;
const NO_DEAL = /^(no deal|regular price|normal price)[\s!.]*$/i;
/** "show me all your products", "see the catalogue", "website": the web catalogue is easier. */
const CATALOGUE =
  /^(?:(?:please|pls|can i|could i|can you|could you)\s+)?(?:(?:show|see|send|view|list|browse|share|give)(?:\s+me)?(?:\s+(?:all|everything|your|the|full|whole|entire|complete|of|link|to|a|whole))*\s+(?:products?|items?|catalog(?:ue)?|website|online (?:shop|store)|everything)|(?:full |your )?catalog(?:ue)?|(?:your )?website|all (?:your )?products|everything you (?:have|sell))(?:\s+(?:please|pls))?[\s!.?]*$/i;
/** Sent instead of an AI reply that states a price the shop didn't produce. */
const PRICE_GUARD_REPLY =
  "Sorry, I can only quote the shop's own prices. Ask me for a better price on a product and I'll check the best I can do, or reply *1* to see our products.";
/** "remove 2" (cart line) or "remove this item". */
const REMOVE = /^(?:remove|delete)\s+(?:(\d{1,2})|this(?: item| one)?|it)[\s!.]*$/i;

/** Where the customer is (Conversation.context.shop): navigation and checkout progress. */
interface ShopState {
  mode: 'menu' | 'list';
  list?: string[];
  query?: string | null;
  page?: number;
  /** The product whose details were shown last ("add 2" adds it). */
  lastProductId?: string;
  checkout?: { orderId: string; step: CheckoutStep; quote: string | null } | undefined;
}

type Account = WhatsAppAccount & { merchant: Merchant };

export interface CustomerConversationDeps {
  db: Database;
  audit: AuditService;
  catalog: CustomerCatalog;
  tools: ToolRegistry<CustomerAgentContext>;
  chatModel: ChatModel | null;
  notifications: NotificationService;
  shop: ShopOrderService;
  /** WhatsApp bargaining (optional: without it, price talk is answered with regular prices). */
  bargaining?: BargainingService;
  /** The public web catalogue and carts sent from it (optional). */
  storefront?: Pick<StorefrontService, 'claim' | 'link'>;
  /** Customer cancellation of their own unpaid orders (optional). */
  lifecycle?: Pick<OrderLifecycleService, 'cancel'>;
  logger: Logger;
  /** Messages per customer per minute before the bot slows them down (default 15). */
  perMinute?: number;
}

/**
 * Customers of a merchant, on that merchant's bot number. Phase 1: discover products (numbered
 * menus, search, details with photos), ask questions, and hand over to a person. Everything is
 * scoped to the bot's merchant and this customer; the admin agent and its tools are never used.
 */
export class CustomerConversationService {
  private readonly rate = new Map<string, number[]>();
  private readonly daily = new Map<string, { day: string; count: number; warned: boolean }>();

  constructor(private readonly deps: CustomerConversationDeps) {}

  async handle(
    message: InboundChannelMessage,
    account: Account,
    identified: IdentifiedCustomer,
  ): Promise<InboundProcessingResult> {
    const { db } = this.deps;
    const merchant = account.merchant;
    const customer = identified.customer;

    const existing = await db.conversation.findUnique({
      where: {
        merchantId_channel_externalChatId: {
          merchantId: merchant.id,
          channel: message.channel,
          externalChatId: message.externalChatId,
        },
      },
    });
    const conversation = await db.conversation.upsert({
      where: {
        merchantId_channel_externalChatId: {
          merchantId: merchant.id,
          channel: message.channel,
          externalChatId: message.externalChatId,
        },
      },
      update: { lastMessageAt: new Date(), audience: 'CUSTOMER', customerId: customer.id },
      create: {
        merchantId: merchant.id,
        channel: message.channel,
        externalChatId: message.externalChatId,
        audience: 'CUSTOMER',
        customerId: customer.id,
      },
    });

    try {
      await db.message.create({
        data: {
          conversationId: conversation.id,
          channel: message.channel,
          externalMessageId: message.externalMessageId,
          direction: 'INBOUND',
          type:
            message.type === 'audio'
              ? 'AUDIO'
              : message.type === 'unsupported'
                ? 'UNSUPPORTED'
                : 'TEXT',
          content:
            message.type === 'unsupported' ? `[${message.unsupportedKind}]` : (message.text ?? ''),
          correlationId: getCorrelationId() ?? null,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        return { status: 'duplicate', replies: [] };
      throw error;
    }

    const text = message.type === 'text' ? (message.text ?? '').trim() : '';

    // Rate limit first, so a flooding customer can't flood the admins during a hand-off either.
    const limited = this.limit(customer.id);
    if (limited === 'silent') return { status: 'processed', replies: [] };
    if (limited === 'warn')
      return this.reply(
        conversation,
        "You're sending messages very quickly. Please wait a moment and try again. 🙏",
      );

    // A cart sent from the website. Before everything else: the prefilled message may contain words
    // the other rules react to, and it is an explicit request to buy, even during a hand-off.
    const reference = CART_REFERENCE.exec(text);
    if (reference && this.deps.storefront)
      return this.receiveCart(account, conversation, customer, reference[0]);

    // Paused for a person: forward to the team, say nothing.
    if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
      await this.deps.notifications.toAdmins(
        merchant.id,
        `💬 *${customer.name}* (${this.contact(customer)}): ${text || '[voice note or media]'}\n_Reply with: reply to ${customer.name}: …_`,
      );
      return { status: 'processed', replies: [] };
    }

    if (message.type !== 'text' || !text) {
      return this.reply(
        conversation,
        'I can only read text messages for now. Please type your question 🙂 Reply *menu* for options.',
      );
    }

    const state = ((conversation.context as { shop?: ShopState } | null)?.shop ??
      null) as ShopState | null;
    const actor: ShopActor = { merchant, customer, conversationId: conversation.id };

    if (HUMAN.test(text))
      return this.handoff(account, conversation, customer, 'Asked for a person', text);

    if (GREETING.test(text)) {
      await this.saveState(conversation, { mode: 'menu' });
      return this.reply(
        conversation,
        this.menu(
          merchant,
          customer,
          identified.created || !existing,
          (await this.deps.storefront?.link(merchant.id)) ?? null,
        ),
      );
    }

    try {
      const cancelOrder = CANCEL_ORDER.exec(text);
      if (cancelOrder) return await this.cancelOrder(conversation, actor, cancelOrder[1]!);

      // ── Bargaining: "deal" takes the shop's open offer, "no deal" keeps regular prices ──
      if (this.deps.bargaining && (DEAL.test(text) || NO_DEAL.test(text))) {
        const result = DEAL.test(text)
          ? await this.deps.bargaining.accept(actor, {})
          : await this.deps.bargaining.decline(actor, null);
        // A price change invalidates a checkout summary in progress.
        if (state?.checkout) await this.saveState(conversation, { ...state, checkout: undefined });
        return this.reply(conversation, result.message);
      }

      // ── Checkout: ORDER places it; answers fill in name / delivery / address ──
      if (ORDER_WORD.test(text)) {
        if (state?.checkout?.step === 'confirm')
          return await this.placeOrder(account, conversation, actor, state);
        return await this.startCheckout(account, conversation, actor, state);
      }
      if (state?.checkout && CANCEL.test(text)) {
        await this.saveState(conversation, { ...state, checkout: undefined });
        return this.reply(
          conversation,
          `No problem, nothing was ordered.\n\n${ShopOrderService.formatCart(await this.deps.shop.cart(merchant.id, customer.id))}`,
        );
      }
      const command = CART.test(text) || ORDERS.test(text) || CHECKOUT.test(text);
      if (state?.checkout && state.checkout.step !== 'confirm' && !command) {
        const error = await this.deps.shop.answer(
          actor,
          state.checkout.orderId,
          state.checkout.step,
          text,
        );
        if (error) return this.reply(conversation, error);
        return await this.startCheckout(account, conversation, actor, state);
      }

      const number = /^\s*(\d{1,3})\s*[.)]?\s*$/.exec(text)?.[1];
      if (number && (!state || state.mode === 'menu')) {
        if (number === '1') return await this.showList(conversation, merchant.id, null, 1, state);
        if (number === '2') return await this.showCart(conversation, actor, state);
        if (number === '3') return await this.showOrders(conversation, actor);
        if (number === '4')
          return this.handoff(account, conversation, customer, 'Asked for a person', text);
        return this.reply(
          conversation,
          'Please reply *1*, *2*, *3* or *4*, or just tell me what you need.',
        );
      }
      if (CART.test(text)) return await this.showCart(conversation, actor, state);
      if (ORDERS.test(text)) return await this.showOrders(conversation, actor);
      if (CHECKOUT.test(text)) return await this.startCheckout(account, conversation, actor, state);
      if (CATALOGUE.test(text)) {
        const link = await this.deps.storefront?.link(merchant.id);
        if (link)
          return this.reply(
            conversation,
            `You can browse all our products with photos here:\n${link}\n\nAdd what you like to your cart, tap *Checkout on WhatsApp* and I'll take it from there. Or just tell me what you're looking for.`,
          );
      }

      const add = ADD.exec(text);
      if (add) {
        const quantity = Number(add[1] ?? 1);
        const item = add[2] ? Number(add[2]) : null;
        const productId =
          item !== null ? state?.list?.[item - 1] : (state?.lastProductId ?? undefined);
        if (!productId)
          return this.reply(
            conversation,
            item !== null
              ? `Please choose a number from the list (1–${state?.list?.length ?? 0}). Reply *1* to see products.`
              : 'Which product? Reply with its number to see it first, or say e.g. *add 2 of 3*.',
          );
        const added = await this.deps.shop.add(actor, productId, quantity);
        await this.saveState(conversation, {
          ...(state ?? { mode: 'menu' }),
          lastProductId: productId,
          checkout: undefined,
        });
        return this.reply(
          conversation,
          `✅ Added: ${added.product} (now ${added.quantity} in your cart).\n\n${ShopOrderService.formatCart(added.cart)}`,
        );
      }
      const remove = REMOVE.exec(text);
      if (remove) {
        const line = remove[1] ? Number(remove[1]) : undefined;
        if (line === undefined && !state?.lastProductId)
          return this.reply(conversation, 'Which item? Reply *cart* and then e.g. *remove 1*.');
        const result = await this.deps.shop.setQuantity(
          actor,
          line !== undefined ? { line } : { productId: state!.lastProductId! },
          0,
        );
        await this.saveState(conversation, { ...(state ?? { mode: 'menu' }), checkout: undefined });
        return this.reply(
          conversation,
          `Removed ${result.product}.\n\n${ShopOrderService.formatCart(result.cart)}`,
        );
      }

      if (number && state?.mode === 'list' && state.list?.length) {
        const id = state.list[Number(number) - 1];
        if (!id)
          return this.reply(
            conversation,
            `Please reply with a number between 1 and ${state.list.length}.`,
          );
        return await this.showDetails(conversation, merchant.id, id, state);
      }
      if (MORE.test(text) && state?.mode === 'list')
        return await this.showList(
          conversation,
          merchant.id,
          state.query ?? null,
          (state.page ?? 1) + 1,
          state,
        );
    } catch (error) {
      // Cart/checkout rules (stock, limits, quantities) explain themselves to the customer.
      if (error instanceof NotFoundError)
        return this.reply(
          conversation,
          "That product isn't available. Reply *1* to see what we have.",
        );
      if (isAppError(error) && error.httpStatus < 500)
        return this.reply(conversation, error.message);
      throw error;
    }

    return this.runAgent(account, conversation, customer, text, state);
  }

  /** A reference from "Checkout on WhatsApp": the web cart joins this customer's cart. */
  private async receiveCart(
    account: Account,
    conversation: Conversation,
    customer: Customer,
    reference: string,
  ) {
    const storefront = this.deps.storefront!;
    const merchant = account.merchant;
    const actor: ShopActor = { merchant, customer, conversationId: conversation.id };
    const state = (conversation.context as { shop?: ShopState } | null)?.shop ?? null;
    const shopLink = await storefront.link(merchant.id);
    const again = shopLink ? `\n\nYou can check out again from ${shopLink}` : '';
    let outcome;
    try {
      outcome = await storefront.claim(actor, reference);
    } catch (error) {
      if (isAppError(error) && error.httpStatus < 500)
        return this.reply(conversation, error.message);
      throw error;
    }
    switch (outcome.status) {
      case 'not_found':
        return this.reply(
          conversation,
          `I couldn't find that cart. Please tap *Checkout on WhatsApp* on the website again.${again}`,
        );
      case 'expired':
        return this.reply(
          conversation,
          `That cart reference has expired or was replaced by a newer one. Nothing was ordered. Your items are still in your cart on the website.${again}`,
        );
      case 'used':
        return this.reply(
          conversation,
          `That cart reference has already been used. Please check out from your own cart on the website.${again}`,
        );
      case 'already_yours': {
        const cart = await this.deps.shop.cart(merchant.id, customer.id);
        return this.reply(
          conversation,
          cart?.items.length
            ? `You've already sent me that cart, so nothing changed.\n\n${ShopOrderService.formatCart(cart)}`
            : "You've already sent me that cart, so nothing changed. Reply *orders* to see your order.",
        );
      }
      case 'claimed':
        break;
    }
    // The customer came back to buy, so a pause for a person would leave them stuck mid-checkout.
    if (conversation.handoffUntil && conversation.handoffUntil > new Date()) {
      await this.deps.db.conversation.update({
        where: { id: conversation.id },
        data: { handoffUntil: null },
      });
      await this.deps.notifications.toAdmins(
        merchant.id,
        `🛒 *${customer.name}* sent a cart from the website, so automated replies are back on for this chat.`,
      );
    }
    const notes = outcome.notes.length ? `${outcome.notes.join('\n')}\n\n` : '';
    const cart = await this.deps.shop.cart(merchant.id, customer.id);
    if (!outcome.added || !cart?.items.length)
      return this.reply(
        conversation,
        `${notes}None of those items can be ordered right now, so nothing was added.${again}`,
      );
    const next = await this.deps.shop.nextStep(actor, account);
    await this.saveState(conversation, {
      ...(state ?? { mode: 'menu' }),
      checkout:
        next.step && next.orderId
          ? { orderId: next.orderId, step: next.step, quote: next.quote ?? null }
          : undefined,
    });
    const items =
      next.step === 'confirm' || !next.step
        ? ''
        : `${cart.items.map((i) => `• ${formatLine(i, cart.currency)}`).join('\n')}\n\n`;
    return this.reply(
      conversation,
      `🛒 Got your cart from our website!\n\n${notes}${items}${next.text}`,
    );
  }

  /** The customer cancels one of their own unpaid orders. */
  private async cancelOrder(conversation: Conversation, actor: ShopActor, reference: string) {
    if (!this.deps.lifecycle)
      return this.reply(conversation, 'Please reply *4* to ask the shop to cancel an order.');
    let outcome;
    try {
      outcome = await this.deps.lifecycle.cancel({
        merchantId: actor.merchant.id,
        reference,
        by: 'CUSTOMER',
        customerId: actor.customer.id,
      });
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (error.code === 'CONFLICT')
        return this.reply(
          conversation,
          'Your payment for this order is being processed right now, so it was not cancelled. Reply *orders* in a few minutes to see its status.',
        );
      if (!error.code.startsWith('PROVIDER')) throw error;
      return this.reply(
        conversation,
        "I couldn't check that order's payment with PayPal just now. Please try again in a few minutes.",
      );
    }
    const ref = reference.toUpperCase();
    if (!outcome)
      return this.reply(
        conversation,
        `I couldn't find order ${ref}. Reply *orders* to see your orders.`,
      );
    switch (outcome.status) {
      case 'cancelled':
        return this.reply(
          conversation,
          `✅ Order ${ref} is cancelled. No money was taken. Reply *1* to keep shopping.`,
        );
      case 'already_cancelled':
        return this.reply(conversation, `Order ${ref} is already cancelled.`);
      case 'paid':
        return this.reply(
          conversation,
          `Order ${ref} has already been paid, so it can't be cancelled here. Reply *4* to talk to the shop.`,
        );
      case 'not_cancellable':
        return this.reply(
          conversation,
          outcome.order.status === 'PAID' || outcome.order.status === 'REFUNDED'
            ? `Order ${ref} has already been paid, so it can't be cancelled here. Reply *4* to talk to the shop.`
            : outcome.order.placedBy === 'CUSTOMER'
              ? `${outcome.reason} Reply *cart* to change it.`
              : `${outcome.reason} Reply *4* to talk to the shop.`,
        );
    }
  }

  private async showCart(conversation: Conversation, actor: ShopActor, state: ShopState | null) {
    if (state?.checkout) await this.saveState(conversation, { ...state, checkout: undefined });
    return this.reply(
      conversation,
      ShopOrderService.formatCart(await this.deps.shop.cart(actor.merchant.id, actor.customer.id)),
    );
  }

  private async showOrders(conversation: Conversation, actor: ShopActor) {
    const orders = await this.deps.shop.myOrders(actor.merchant.id, actor.customer.id);
    return this.reply(conversation, ShopOrderService.formatOrders(orders));
  }

  /** Checkout: ask for what's missing, or show the summary to confirm with ORDER. */
  private async startCheckout(
    account: Account,
    conversation: Conversation,
    actor: ShopActor,
    state: ShopState | null,
  ) {
    const next = await this.deps.shop.nextStep(actor, account);
    await this.saveState(conversation, {
      ...(state ?? { mode: 'menu' }),
      checkout:
        next.step && next.orderId
          ? { orderId: next.orderId, step: next.step, quote: next.quote ?? null }
          : undefined,
    });
    return this.reply(conversation, next.text);
  }

  private async placeOrder(
    account: Account,
    conversation: Conversation,
    actor: ShopActor,
    state: ShopState,
  ) {
    const checkout = state.checkout!;
    const result = await this.deps.shop.place(
      actor,
      account,
      checkout.orderId,
      checkout.quote ?? null,
    );
    const done = { ...state, checkout: undefined };
    switch (result.status) {
      case 'link':
        await this.saveState(conversation, done);
        return this.reply(
          conversation,
          `🎉 *Order ${result.reference} placed!* Total: *${result.total}*.\n\nPay securely with PayPal:\n${result.link}\n\nWe'll confirm here as soon as your payment arrives. Reply *orders* to check its status.`,
        );
      case 'awaiting_approval':
        await this.saveState(conversation, done);
        return this.reply(
          conversation,
          `🎉 *Order ${result.reference} received!* Total: *${result.total}*.\n\nThe shop will confirm it and send your secure PayPal payment link here shortly.`,
        );
      case 'already':
        await this.saveState(conversation, done);
        return this.reply(
          conversation,
          `Order ${result.reference} is already placed.${result.link ? `\n\nPay securely with PayPal:\n${result.link}` : ''}`,
        );
      case 'paid':
        await this.saveState(conversation, done);
        return this.reply(
          conversation,
          `Order ${result.reference} is already paid. Thank you! Reply *orders* for its status.`,
        );
      case 'changed':
        await this.saveState(conversation, {
          ...state,
          checkout: { ...checkout, quote: result.quote },
        });
        return this.reply(
          conversation,
          `Something changed since you last saw your order. Please check it again:\n\n${result.summary}`,
        );
      case 'expired':
        await this.saveState(conversation, done);
        return this.reply(
          conversation,
          'That cart has expired. Reply *1* to browse products and start again.',
        );
      case 'paypal_failed':
        return this.reply(
          conversation,
          `Your order ${result.reference} is saved, but PayPal didn't respond. Please reply *ORDER* again in a minute to get your payment link.`,
        );
      case 'refused':
        await this.saveState(conversation, done);
        return this.reply(conversation, result.reason);
    }
  }

  /** "1" or "browse": a numbered page of products. */
  private async showList(
    conversation: Conversation,
    merchantId: string,
    query: string | null,
    page: number,
    state: ShopState | null = null,
  ) {
    const { result, text } = await this.deps.catalog.listing(
      merchantId,
      query,
      page,
      this.deps.storefront,
    );
    await this.saveState(conversation, {
      mode: 'list',
      list: result.ids,
      query,
      page: result.page,
      ...(state?.lastProductId ? { lastProductId: state.lastProductId } : {}),
    });
    return this.reply(conversation, text);
  }

  private async showDetails(
    conversation: Conversation,
    merchantId: string,
    productId: string,
    state: ShopState | null = null,
  ) {
    const product = await this.deps.catalog.find(merchantId, productId);
    if (!product)
      return this.reply(
        conversation,
        'That product is no longer available. Reply *1* to see what we have.',
      );
    await this.saveState(conversation, {
      ...(state ?? { mode: 'menu' }),
      lastProductId: product.id,
      checkout: undefined,
    });
    const photo = product.hasPhoto ? await this.deps.catalog.photo(merchantId, product.id) : null;
    return this.reply(
      conversation,
      CustomerCatalog.formatDetails(product),
      photo ? [{ media: photo, caption: `${product.name} — ${product.price}` }] : [],
    );
  }

  private menu(merchant: Merchant, customer: Customer, firstTime: boolean, link: string | null) {
    const name =
      customer.source === 'WHATSAPP' && customer.name === 'WhatsApp customer'
        ? ''
        : ` ${customer.name.split(' ')[0]}`;
    return [
      `${firstTime ? 'Hello' : 'Welcome back'}${name}! 👋 Welcome to *${merchant.businessName}*.`,
      '',
      '*1* Browse products',
      '*2* My cart',
      '*3* My orders',
      '*4* Talk to a person',
      '',
      "Reply with a number, or just tell me what you're looking for.",
      ...(link ? ['', `🛍️ Browse our full catalogue: ${link}`] : []),
    ].join('\n');
  }

  private async runAgent(
    account: Account,
    conversation: Conversation,
    customer: Customer,
    text: string,
    state: ShopState | null,
  ) {
    const merchant = account.merchant;
    if (!chatModelReady(this.deps.chatModel))
      return this.showList(conversation, merchant.id, text, 1, state);
    const recent = await this.deps.db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS + 1,
    });
    const history: ChatMessage[] = recent
      .slice(1)
      .reverse()
      .filter((m) => m.content && !m.content.startsWith('[product photo]'))
      .map((m) =>
        m.direction === 'INBOUND'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content },
      );
    const context: CustomerAgentContext = {
      merchant,
      account,
      customer,
      conversation,
      attachments: [],
      shownList: state?.list ?? null,
      lastProductId: state?.lastProductId ?? null,
      handoffReason: null,
      verbatim: null,
      checkout: null,
      bargain: null,
    };
    let result;
    try {
      result = await runAgent({
        model: this.deps.chatModel,
        tools: this.deps.tools,
        systemPrompt: buildCustomerPrompt({
          merchant,
          hasCatalogue: !!(await this.deps.storefront?.link(merchant.id)),
        }),
        history,
        userMessage: text,
        context,
        maxSteps: 4,
        logger: this.deps.logger,
      });
    } catch (error) {
      // AI unavailable: still useful, deterministically — search the catalog for their words.
      if (!isAppError(error) || !error.code.startsWith('PROVIDER')) throw error;
      this.deps.logger.warn({ err: error }, 'customer agent provider failure');
      return this.showList(conversation, merchant.id, text, 1, state);
    }
    if (context.handoffReason)
      return this.handoff(account, conversation, customer, context.handoffReason, text);
    const reply =
      context.verbatim ??
      (await this.guardPrices(account, conversation, customer, result, history, context));
    const listChanged = !!context.shownList && context.shownList !== state?.list;
    await this.saveState(conversation, {
      ...(state ?? { mode: 'menu' }),
      ...(listChanged
        ? { mode: 'list' as const, list: context.shownList!, query: null, page: 1 }
        : {}),
      ...(context.lastProductId ? { lastProductId: context.lastProductId } : {}),
      // Checkout started by the assistant: its backend-built prompt is the reply, verbatim.
      // A bargaining step changes prices, so a summary shown before it is no longer valid.
      checkout:
        context.checkout ?? (context.verbatim || context.bargain ? undefined : state?.checkout),
    });
    return this.reply(conversation, reply, context.attachments.slice(0, 3));
  }

  /**
   * The AI phrases replies, but every money amount in them must come from the backend: tool
   * results this turn, or the shop's own earlier messages. After a bargaining step the reply must
   * also state the shop's actual offer. Otherwise the backend's own wording is sent instead and
   * the attempt is audited, so the model can't be talked into "agreeing" to a price.
   */
  private async guardPrices(
    account: Account,
    conversation: Conversation,
    customer: Customer,
    result: { reply: string; steps: { tool: string; result: unknown }[] },
    history: ChatMessage[],
    context: CustomerAgentContext,
  ): Promise<string> {
    const currency = account.merchant.preferredCurrency;
    const allowed = new Set<number>(context.bargain?.allowedMinor ?? []);
    for (const step of result.steps)
      for (const amount of moneyAmounts(JSON.stringify(step.result), currency)) allowed.add(amount);
    for (const message of history)
      if (message.role === 'assistant' && message.content)
        for (const amount of moneyAmounts(message.content, currency)) allowed.add(amount);
    const check = checkReplyPrices({
      reply: result.reply,
      currency,
      allowedMinor: allowed,
      requiredMinor: context.bargain?.keyMinor ?? null,
    });
    if (check.ok) return result.reply;
    this.deps.logger.warn(
      { unexpected: check.unexpected, missing: check.missing, conversationId: conversation.id },
      'customer reply blocked by the price guard',
    );
    await this.deps.audit.record({
      merchantId: account.merchantId,
      actor: 'SYSTEM',
      type: 'customer.price_guard',
      entityType: 'customer',
      entityId: customer.id,
      data: { unexpectedMinor: check.unexpected, missingMinor: check.missing, currency },
    });
    return context.bargain?.message ?? PRICE_GUARD_REPLY;
  }

  /** Pause automated replies and tell the team. */
  private async handoff(
    account: Account,
    conversation: Conversation,
    customer: Customer,
    reason: string,
    text: string,
  ) {
    const until = new Date(Date.now() + account.handoffHours * HOUR);
    await this.deps.db.conversation.update({
      where: { id: conversation.id },
      data: { handoffUntil: until, context: { shop: { mode: 'menu' } } },
    });
    const delivered = await this.deps.notifications.toAdmins(
      account.merchantId,
      [
        '🙋 *A customer needs help*',
        `${customer.name} (${this.contact(customer)})`,
        `Reason: ${reason}`,
        `Last message: “${text.slice(0, 300)}”`,
        '',
        `Reply with: *reply to ${customer.name}: your message*`,
        `Automated replies are paused for ${account.handoffHours} hours. Say *resume ${customer.name}* to switch them back on.`,
      ].join('\n'),
    );
    await this.deps.audit.record({
      merchantId: account.merchantId,
      actor: 'SYSTEM',
      type: 'customer.handoff',
      entityType: 'customer',
      entityId: customer.id,
      data: {
        name: customer.name,
        reason: reason.slice(0, 200),
        hours: account.handoffHours,
        adminsNotified: delivered,
      },
    });
    return this.reply(
      conversation,
      delivered
        ? "I've let the team know. Someone will reply here as soon as possible. 🙏"
        : "I've passed your message to the team. Someone will get back to you as soon as possible. 🙏",
    );
  }

  /** The admin side: switch automated replies back on for a customer. */
  async resume(merchantId: string, customerId: string, via: 'whatsapp' | 'dashboard') {
    const updated = await this.deps.db.conversation.updateMany({
      where: { merchantId, customerId, audience: 'CUSTOMER', handoffUntil: { not: null } },
      data: { handoffUntil: null },
    });
    await this.deps.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'customer.resumed',
      entityType: 'customer',
      entityId: customerId,
      data: { via, conversations: updated.count },
    });
    return updated.count;
  }

  /** The admin side: send a message to a customer who wrote to the shop. Keeps the bot paused. */
  async replyAsTeam(merchantId: string, customerId: string, text: string) {
    const conversation = await this.deps.db.conversation.findFirst({
      where: { merchantId, customerId, audience: 'CUSTOMER', channel: 'whatsapp' },
      include: { customer: true, merchant: { include: { whatsappAccounts: true } } },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (!conversation) throw new NotFoundError('Customer conversation', customerId);
    const body = text.trim();
    if (!body) throw new ConflictError('The message is empty.');
    await this.deps.notifications.sendToChat(
      merchantId,
      conversation.externalChatId,
      body.slice(0, 2000),
    );
    const hours = conversation.merchant.whatsappAccounts[0]?.handoffHours ?? 12;
    const until = new Date(Date.now() + hours * HOUR);
    if (!conversation.handoffUntil || conversation.handoffUntil < until)
      await this.deps.db.conversation.update({
        where: { id: conversation.id },
        data: { handoffUntil: until },
      });
    await this.deps.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'customer.team_reply',
      entityType: 'customer',
      entityId: customerId,
      data: { name: conversation.customer?.name ?? null, preview: body.slice(0, 80) },
    });
  }

  /** Customers who wrote to the shop, most recent first, with hand-off state. */
  recentChats(merchantId: string, limit = 20) {
    return this.deps.db.conversation.findMany({
      where: { merchantId, audience: 'CUSTOMER', customerId: { not: null } },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
    });
  }

  private contact(customer: Customer) {
    return customer.whatsappPhone ?? chatIdToPhone(customer.whatsappId ?? '') ?? 'WhatsApp';
  }

  private limit(customerId: string): 'ok' | 'warn' | 'silent' {
    const perMinute = this.deps.perMinute ?? PER_MINUTE;
    const now = Date.now();
    const recent = (this.rate.get(customerId) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.rate.set(customerId, recent);
    if (this.rate.size > 10_000) this.rate.delete(this.rate.keys().next().value!);
    const day = new Date(now).toISOString().slice(0, 10);
    const d = this.daily.get(customerId);
    const today = d && d.day === day ? d : { day, count: 0, warned: false };
    today.count++;
    this.daily.set(customerId, today);
    if (this.daily.size > 10_000) this.daily.delete(this.daily.keys().next().value!);
    if (recent.length > perMinute || today.count > PER_DAY) {
      if (recent.length === perMinute + 1 || (today.count === PER_DAY + 1 && !today.warned)) {
        today.warned = true;
        return 'warn';
      }
      return 'silent';
    }
    return 'ok';
  }

  private saveState(conversation: Conversation, shop: ShopState) {
    const context = { ...((conversation.context as object | null) ?? {}), shop };
    return this.deps.db.conversation.update({
      where: { id: conversation.id },
      data: { context: JSON.parse(JSON.stringify(context)) as object },
    });
  }

  private async reply(
    conversation: Conversation,
    text: string,
    attachments: { media: OutboundMedia; caption: string }[] = [],
  ): Promise<InboundProcessingResult> {
    const replies: InboundProcessingResult['replies'] = [
      ...attachments.map((a) => ({
        channel: conversation.channel as 'whatsapp',
        externalChatId: conversation.externalChatId,
        text: a.caption,
        media: a.media,
      })),
      ...(text.trim()
        ? [
            {
              channel: conversation.channel as 'whatsapp',
              externalChatId: conversation.externalChatId,
              text,
            },
          ]
        : []),
    ];
    for (const r of replies) {
      await this.deps.db.message.create({
        data: {
          conversationId: conversation.id,
          channel: conversation.channel,
          direction: 'OUTBOUND',
          type: 'TEXT',
          content: r.media ? `[product photo] ${r.text}` : r.text,
          correlationId: getCorrelationId() ?? null,
        },
      });
    }
    return { status: 'processed', replies };
  }
}
