import { defineTool, ToolRegistry } from '@vca/ai';
import type { Conversation, Customer, Merchant, WhatsAppAccount } from '@vca/database';
import type { OutboundMedia } from '@vca/shared';
import { z } from 'zod';
import { CustomerCatalog } from './catalog';

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
  /** Set by request_human; the service pauses automated replies and alerts the admins. */
  handoffReason: string | null;
}

/**
 * The customer agent's tools. Deliberately small and read-only (plus "talk to a person"): no
 * orders, payments, customers, stock counts, analytics or admin actions are reachable from a
 * customer conversation, whatever the model is told.
 */
export function createCustomerTools(catalog: CustomerCatalog): ToolRegistry<CustomerAgentContext> {
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
