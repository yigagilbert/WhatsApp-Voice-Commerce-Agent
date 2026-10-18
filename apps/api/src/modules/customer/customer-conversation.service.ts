import { runAgent, type ChatMessage, type ChatModel, type ToolRegistry } from '@vca/ai';
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
import { CustomerCatalog } from './catalog';
import { buildCustomerPrompt } from './customer-prompt';
import type { CustomerAgentContext } from './customer-tools';

const HOUR = 3_600_000;
const PER_MINUTE = 15;
const PER_DAY = 300;
const HISTORY_TURNS = 12;

const GREETING =
  /^(hi+|hello|hey|hallo|good (morning|afternoon|evening)|start|menu|help|0|hola|oli otya)[\s!.?]*$/i;
const HUMAN =
  /\b(human|real person|a person|someone|agent|staff|owner|manager|talk to (the )?(team|shop|seller))\b/i;
const MORE = /^(more|next|more please|next page)[\s!.?]*$/i;

/** Where the customer is in the numbered navigation (Conversation.context.shop). */
interface ShopState {
  mode: 'menu' | 'list';
  list?: string[];
  query?: string | null;
  page?: number;
}

type Account = WhatsAppAccount & { merchant: Merchant };

export interface CustomerConversationDeps {
  db: Database;
  audit: AuditService;
  catalog: CustomerCatalog;
  tools: ToolRegistry<CustomerAgentContext>;
  chatModel: ChatModel | null;
  notifications: NotificationService;
  logger: Logger;
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

    if (HUMAN.test(text))
      return this.handoff(account, conversation, customer, 'Asked for a person', text);

    if (GREETING.test(text)) {
      await this.saveState(conversation, { mode: 'menu' });
      return this.reply(
        conversation,
        this.menu(merchant, customer, identified.created || !existing),
      );
    }

    const number = /^\s*(\d{1,3})\s*[.)]?\s*$/.exec(text)?.[1];
    if (number && (!state || state.mode === 'menu')) {
      if (number === '1') return this.showList(conversation, merchant.id, null, 1);
      if (number === '2')
        return this.reply(
          conversation,
          'Of course! What would you like to know? You can ask about our products, prices, delivery or anything else.',
        );
      if (number === '3')
        return this.handoff(account, conversation, customer, 'Asked for a person', text);
      return this.reply(
        conversation,
        'Please reply *1*, *2* or *3*, or just tell me what you need.',
      );
    }
    if (number && state?.mode === 'list' && state.list?.length) {
      const index = Number(number) - 1;
      const id = state.list[index];
      if (!id)
        return this.reply(
          conversation,
          `Please reply with a number between 1 and ${state.list.length}.`,
        );
      return this.showDetails(conversation, merchant.id, id);
    }
    if (MORE.test(text) && state?.mode === 'list')
      return this.showList(conversation, merchant.id, state.query ?? null, (state.page ?? 1) + 1);

    return this.runAgent(account, conversation, customer, text);
  }

  /** "1" or "browse": a numbered page of products. */
  private async showList(
    conversation: Conversation,
    merchantId: string,
    query: string | null,
    page: number,
  ) {
    const result = await this.deps.catalog.search(merchantId, query, page);
    await this.saveState(conversation, {
      mode: 'list',
      list: result.ids,
      query,
      page: result.page,
    });
    return this.reply(conversation, CustomerCatalog.formatList(result));
  }

  private async showDetails(conversation: Conversation, merchantId: string, productId: string) {
    const product = await this.deps.catalog.find(merchantId, productId);
    if (!product)
      return this.reply(
        conversation,
        'That product is no longer available. Reply *1* to see what we have.',
      );
    const photo = product.hasPhoto ? await this.deps.catalog.photo(merchantId, product.id) : null;
    return this.reply(
      conversation,
      CustomerCatalog.formatDetails(product),
      photo ? [{ media: photo, caption: `${product.name} — ${product.price}` }] : [],
    );
  }

  private menu(merchant: Merchant, customer: Customer, firstTime: boolean) {
    const name =
      customer.source === 'WHATSAPP' && customer.name === 'WhatsApp customer'
        ? ''
        : ` ${customer.name.split(' ')[0]}`;
    return [
      `${firstTime ? 'Hello' : 'Welcome back'}${name}! 👋 Welcome to *${merchant.businessName}*.`,
      '',
      '*1* Browse products',
      '*2* Ask a question',
      '*3* Talk to a person',
      '',
      "Reply with a number, or just tell me what you're looking for.",
    ].join('\n');
  }

  private async runAgent(
    account: Account,
    conversation: Conversation,
    customer: Customer,
    text: string,
  ) {
    const merchant = account.merchant;
    if (!this.deps.chatModel) return this.showList(conversation, merchant.id, text, 1);
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
    const state = (conversation.context as { shop?: ShopState } | null)?.shop;
    const context: CustomerAgentContext = {
      merchant,
      account,
      customer,
      conversation,
      attachments: [],
      shownList: state?.list ?? null,
      handoffReason: null,
    };
    let result;
    try {
      result = await runAgent({
        model: this.deps.chatModel,
        tools: this.deps.tools,
        systemPrompt: buildCustomerPrompt({ merchant }),
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
      return this.showList(conversation, merchant.id, text, 1);
    }
    if (context.handoffReason)
      return this.handoff(account, conversation, customer, context.handoffReason, text);
    if (context.shownList && context.shownList !== state?.list)
      await this.saveState(conversation, {
        mode: 'list',
        list: context.shownList,
        query: null,
        page: 1,
      });
    return this.reply(conversation, result.reply, context.attachments.slice(0, 3));
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
    if (recent.length > PER_MINUTE || today.count > PER_DAY) {
      if (recent.length === PER_MINUTE + 1 || (today.count === PER_DAY + 1 && !today.warned)) {
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
