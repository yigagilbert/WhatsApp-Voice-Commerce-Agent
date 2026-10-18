import { defineTool, ToolRegistry } from '@vca/ai';
import {
  draftOrderCommandSchema,
  evaluatePaymentRequest,
  formatConfirmationPrompt,
  formatMoney,
  formatOrderSummary,
  orderRefSchema,
  salesPeriodSchema,
  type AnalyticsService,
  type ConfirmationService,
  type CustomerService,
  type InventoryService,
  type OrderService,
  type PaymentPolicyConfig,
  type ProductService,
} from '@vca/commerce';
import type { Conversation, Merchant, Prisma } from '@vca/database';
import { PolicyViolationError, ValidationError, type OutboundMedia } from '@vca/shared';
import { canApprove, toMinorUnits, normalizeCurrency } from '@vca/commerce';
import { z } from 'zod';
import type { PaymentService } from '../payments/payment.service';
import type { PaymentReminderService } from '../payments/reminder.service';
import type { ReportService } from '../reports/report.service';
import { ShipmentService, carrierDisplay } from '../shipments/shipment.service';
import { reasonLabel, statusLabel, type DisputeService } from '../disputes/dispute.service';
import { branded } from './copy';

export interface AgentContext {
  merchant: Merchant;
  conversation: Conversation;
  channel: string;
  /**
   * Confirmations proposed during this turn. Their backend-generated prompt becomes the
   * reply verbatim, so the model can never misstate an amount the merchant is confirming.
   */
  proposals: { confirmationId: string; prompt: string }[];
  /** Backend-generated notices (e.g. a policy refusal) shown verbatim when no proposal was made. */
  notices: string[];
  /** Images to send with the reply (charts). Built by the backend from trusted data. */
  attachments?: { media: OutboundMedia; caption: string }[];
  /** The request came from a voice note (stricter: no silent customer or product guesses). */
  fromVoice?: boolean;
  /** The admin's role; STAFF can't propose owner-only actions (default OWNER, e.g. the console). */
  operatorRole?: 'OWNER' | 'STAFF';
}

/** Owner-only action requested by a staff admin: show why, propose nothing. */
const needsOwner = (ctx: AgentContext, summary: string, ask: string) => {
  ctx.notices.push(
    branded(`${summary}\n\n🔒 Only an owner can approve this. Ask an owner to message me: ${ask}`),
  );
  return { status: 'needs_owner', note: 'Only an owner can approve this. Nothing was proposed.' };
};

export interface ToolDeps {
  customers: CustomerService;
  products: ProductService;
  orders: OrderService;
  confirmations: ConfirmationService;
  analytics: AnalyticsService;
  payments: Pick<PaymentService, 'list'>;
  reminders: Pick<PaymentReminderService, 'prepare'>;
  inventory: InventoryService;
  reports: ReportService;
  shipments: ShipmentService;
  disputes: DisputeService;
  policy: PaymentPolicyConfig;
  confirmationTtlSeconds: number;
}

type OrderDetails = Awaited<ReturnType<OrderService['getByReference']>>;

const money = (minor: number, currency: string) => formatMoney(minor, currency);

/** Compact, model-friendly view of an order with pre-formatted amounts. */
const orderView = (order: OrderDetails) => ({
  reference: order.reference,
  status: order.status,
  customer: order.customer.name,
  items: order.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unit_price: money(i.unitPriceMinor, order.currency),
    line_total: money(i.lineTotalMinor, order.currency),
  })),
  subtotal: money(order.subtotalMinor, order.currency),
  shipping: money(order.shippingMinor, order.currency),
  tax: money(order.taxMinor, order.currency),
  total: money(order.totalMinor, order.currency),
  payments: order.payments.map((p) => ({
    status: p.status,
    amount: money(p.amountMinor, p.currency),
    checkout_url: p.checkoutUrl,
  })),
  created_at: order.createdAt.toISOString(),
});

/** Validates policy, records a pending confirmation, and queues the deterministic prompt. */
async function proposePaymentRequest(
  deps: ToolDeps,
  ctx: AgentContext,
  order: OrderDetails,
  extras: { isNewCustomer?: boolean; warnings?: string[] } = {},
) {
  const summary = formatOrderSummary({
    reference: order.reference,
    customerName: order.customer.name,
    isNewCustomer: extras.isNewCustomer ?? false,
    currency: order.currency,
    items: order.items,
    subtotalMinor: order.subtotalMinor,
    shippingMinor: order.shippingMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    warnings: extras.warnings ?? [],
  });

  const decision = evaluatePaymentRequest(order, deps.policy);
  if (!decision.allowed) {
    ctx.notices.push(
      branded(`${summary}\n\n⛔ ${decision.reason} No payment request was created.`),
    );
    return {
      order_reference: order.reference,
      payment_request: 'refused_by_policy',
      reason: decision.reason,
      summary,
    };
  }

  if (!canApprove(ctx.operatorRole ?? 'OWNER', 'CREATE_PAYMENT_REQUEST')) {
    return {
      order_reference: order.reference,
      ...needsOwner(ctx, summary, `“request payment for ${order.reference}”.`),
    };
  }

  const confirmation = await deps.confirmations.propose({
    merchantId: ctx.merchant.id,
    conversationId: ctx.conversation.id,
    action: 'CREATE_PAYMENT_REQUEST',
    payload: {
      orderId: order.id,
      orderReference: order.reference,
      totalMinor: order.totalMinor,
      currency: order.currency,
    },
    summary,
    ttlSeconds: deps.confirmationTtlSeconds,
  });
  ctx.proposals.push({
    confirmationId: confirmation.id,
    prompt: branded(
      `${summary}\n\n${formatConfirmationPrompt({
        actionDescription: 'create the PayPal payment request',
        code: confirmation.code,
        ttlSeconds: deps.confirmationTtlSeconds,
      })}`,
    ),
  });
  return {
    order_reference: order.reference,
    total: money(order.totalMinor, order.currency),
    status: 'awaiting_merchant_confirmation',
    note: 'The system shows the merchant the exact summary and a confirmation code. Do not repeat the amounts; do not say the payment was created.',
  };
}

/**
 * The commerce tools the LLM may call. Adding a capability = adding one `defineTool` here.
 * No tool can move money: the most a tool can do is *propose* a payment request.
 */
export function createCommerceTools(deps: ToolDeps): ToolRegistry<AgentContext> {
  const registry = new ToolRegistry<AgentContext>();

  registry
    .register(
      defineTool({
        name: 'find_customer',
        kind: 'read',
        description: 'Search the merchant’s customers by name, email or phone.',
        input: z.object({ query: z.string().min(1).max(120) }),
        async execute({ query }, ctx) {
          const results = await deps.customers.search(ctx.merchant.id, query);
          return results.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            has_whatsapp: !!c.whatsappId,
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'create_customer',
        kind: 'write',
        description: 'Create a new customer record. Only when the merchant asks to add a customer.',
        input: z.object({
          name: z.string().min(1).max(120),
          email: z.string().email().optional(),
          phone: z.string().max(32).optional(),
        }),
        async execute(input, ctx) {
          const c = await deps.customers.create(ctx.merchant.id, input);
          return { id: c.id, name: c.name };
        },
      }),
    )
    .register(
      defineTool({
        name: 'list_products',
        kind: 'read',
        description: 'List the merchant’s active products with prices and stock.',
        input: z.object({}),
        async execute(_input, ctx) {
          const products = await deps.products.list(ctx.merchant.id, { activeOnly: true });
          return products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            price: money(p.unitPriceMinor, p.currency),
            stock: p.stockQuantity,
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'find_product',
        kind: 'read',
        description: 'Find catalog products matching a name.',
        input: z.object({ query: z.string().min(1).max(120) }),
        async execute({ query }, ctx) {
          const products = await deps.products.search(ctx.merchant.id, query);
          return products.map((p) => ({
            id: p.id,
            name: p.name,
            price: money(p.unitPriceMinor, p.currency),
            stock: p.stockQuantity,
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'check_inventory',
        kind: 'read',
        description:
          'Stock of one product by name. For several products, low stock or reorder advice use inventory_report.',
        input: z.object({ product_name: z.string().min(1).max(120) }),
        async execute({ product_name }, ctx) {
          const products = await deps.products.search(ctx.merchant.id, product_name);
          return products.map((p) => ({ name: p.name, stock: p.stockQuantity ?? 'not tracked' }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'calculate_order_total',
        kind: 'read',
        description:
          'Price a prospective order without creating it (for quotes like "how much would 20 wallets be?").',
        input: draftOrderCommandSchema,
        async execute(command, ctx) {
          const { totals, warnings } = await deps.orders.price(ctx.merchant, command);
          return {
            currency: totals.currency,
            lines: totals.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              line_total: money(l.lineTotalMinor, totals.currency),
            })),
            subtotal: money(totals.subtotalMinor, totals.currency),
            shipping: money(totals.shippingMinor, totals.currency),
            tax: money(totals.taxMinor, totals.currency),
            total: money(totals.totalMinor, totals.currency),
            warnings,
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'create_draft_order',
        kind: 'propose',
        description:
          'Create a DRAFT order from what the merchant said and propose a PayPal payment request. ' +
          'The merchant must then confirm; nothing is charged by this tool.',
        input: draftOrderCommandSchema,
        async execute(command, ctx) {
          const { order, isNewCustomer, warnings } = await deps.orders.createDraft({
            merchant: ctx.merchant,
            command,
            source: ctx.channel,
            conversationId: ctx.conversation.id,
            inputMode: ctx.fromVoice ? 'VOICE' : 'TEXT',
          });
          return proposePaymentRequest(deps, ctx, order, { isNewCustomer, warnings });
        },
      }),
    )
    .register(
      defineTool({
        name: 'request_payment',
        kind: 'propose',
        description:
          'Propose a PayPal payment request for an existing DRAFT order. The merchant must confirm.',
        input: orderRefSchema,
        async execute({ order_reference }, ctx) {
          const order = await deps.orders.getByReference(ctx.merchant.id, order_reference);
          if (order.status !== 'DRAFT') {
            throw new PolicyViolationError(
              `Order ${order.reference} is ${order.status}; payment can only be requested for draft orders.`,
            );
          }
          return proposePaymentRequest(deps, ctx, order);
        },
      }),
    )
    .register(
      defineTool({
        name: 'get_order',
        kind: 'read',
        description: 'Get an order by reference, including items, totals and payments.',
        input: orderRefSchema,
        async execute({ order_reference }, ctx) {
          return orderView(await deps.orders.getByReference(ctx.merchant.id, order_reference));
        },
      }),
    )
    .register(
      defineTool({
        name: 'get_payment_status',
        kind: 'read',
        description: 'Get the payment status of an order.',
        input: orderRefSchema,
        async execute({ order_reference }, ctx) {
          const order = await deps.orders.getByReference(ctx.merchant.id, order_reference);
          const latest = order.payments[0];
          return {
            order_reference: order.reference,
            order_status: order.status,
            payment_status: latest?.status ?? 'NO_PAYMENT_REQUESTED',
            amount: latest ? money(latest.amountMinor, latest.currency) : null,
            paid_at: latest?.completedAt?.toISOString() ?? null,
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'find_orders',
        kind: 'read',
        description:
          'Find orders and count them, with optional filters. Use for "which orders are unpaid?", ' +
          '"how many orders are waiting for payment?", "show me today\'s orders", "has Sarah paid?", ' +
          '"voice orders this week", "which paid orders still need shipping?" (status PAID + fulfillment NOT_SHIPPED). ' +
          'Returns the database count, the total value and the most recent matches.',
        input: z.object({
          status: z
            .enum(['DRAFT', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED'])
            .optional()
            .describe('DRAFT = not yet confirmed; AWAITING_PAYMENT = payment link sent, unpaid'),
          period: salesPeriodSchema.optional().describe('When the order was created'),
          customer: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .describe('Customer name (partial is fine)'),
          input_mode: z.enum(['TEXT', 'VOICE']).optional().describe('How the merchant asked'),
          fulfillment: z
            .enum(['NOT_SHIPPED', 'SHIPPED'])
            .optional()
            .describe('NOT_SHIPPED = no tracking yet; SHIPPED = tracking added'),
          limit: z.number().int().min(1).max(20).default(5),
        }),
        async execute({ status, period, customer, input_mode, fulfillment, limit }, ctx) {
          const result = await deps.orders.find(ctx.merchant, {
            ...(status ? { status } : {}),
            ...(period ? { period } : {}),
            ...(customer ? { customer } : {}),
            ...(input_mode ? { inputMode: input_mode } : {}),
            ...(fulfillment ? { fulfillment } : {}),
            limit,
          });
          return {
            period: result.period,
            count: result.count,
            total_value: result.total,
            showing: result.orders.length,
            orders: result.orders.map((o) => ({
              reference: o.reference,
              customer: o.customer.name,
              status: o.status,
              total: money(o.totalMinor, o.currency),
              items: o.items.map((i) => `${i.quantity} × ${i.description}`).join(', '),
              via: o.inputMode === 'VOICE' ? 'voice note' : 'text',
              fulfillment: o.fulfillmentStatus,
              created_at: o.createdAt.toISOString(),
            })),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'list_payments',
        kind: 'read',
        description:
          'List PayPal payments, newest first, optionally by status. Use for "what was my last payment?" ' +
          'or "which payments are pending?". Payment status comes from PayPal, never from the conversation.',
        input: z.object({
          status: z
            .enum(['CREATED', 'APPROVED', 'COMPLETED', 'FAILED', 'CANCELLED'])
            .optional()
            .describe('CREATED = link sent, not paid; COMPLETED = money received'),
          limit: z.number().int().min(1).max(20).default(5),
        }),
        async execute({ status, limit }, ctx) {
          const payments = await deps.payments.list(ctx.merchant.id, { status, limit });
          return payments.map((p) => ({
            order_reference: p.order.reference,
            customer: p.order.customer.name,
            status: p.status,
            amount: money(p.amountMinor, p.currency),
            requested_at: p.createdAt.toISOString(),
            paid_at: p.completedAt?.toISOString() ?? null,
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'get_customer_summary',
        kind: 'read',
        description:
          "A customer's details, number of orders, total paid, outstanding balance and last order. " +
          'Use for "who is Sarah?", "how many orders has Sarah made?", "how much has Sarah spent?".',
        input: z.object({ customer: z.string().min(1).max(120) }),
        async execute({ customer }, ctx) {
          const matches = await deps.analytics.customerSummary(ctx.merchant.id, customer);
          return matches.length
            ? matches
            : { found: false, message: `No customer matches '${customer}'.` };
        },
      }),
    )
    // ─── Shipments ─────────────────────────────────────────────────────────
    .register(
      defineTool({
        name: 'get_shipping_status',
        kind: 'read',
        description:
          'Payment and shipping status of one order, with carrier and tracking number. Use for "where is ORD-1042?" or "what\'s the tracking number for ORD-1042?".',
        input: orderRefSchema,
        async execute({ order_reference }, ctx) {
          const { order, shipments } = await deps.shipments.statusFor(
            ctx.merchant.id,
            order_reference,
          );
          return {
            order_reference: order.reference,
            customer: order.customer.name,
            payment: order.status === 'PAID' ? 'paid' : order.status.toLowerCase(),
            fulfillment: shipments.length ? 'shipped' : 'not shipped',
            shipments: shipments.map((sh) => ({
              carrier: carrierDisplay(sh),
              tracking_number: sh.trackingNumber,
              status: sh.status,
              shipped_at: sh.shippedAt.toISOString(),
              registered_with_paypal: !!sh.providerTrackerId,
            })),
            note: 'PayPal tracking has no delivered status; Katale does not know delivery dates.',
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'list_shipments',
        kind: 'read',
        description:
          'Recent shipments (orders with tracking), newest first. Use for "which orders have tracking?" or "what did I ship this week?".',
        input: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
        async execute({ limit }, ctx) {
          const shipments = await deps.shipments.list(ctx.merchant.id, limit);
          return shipments.map((sh) => ({
            order_reference: sh.order.reference,
            customer: sh.order.customer.name,
            carrier: carrierDisplay(sh),
            tracking_number: sh.trackingNumber,
            status: sh.status,
            shipped_at: sh.shippedAt.toISOString(),
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'add_shipment_tracking',
        kind: 'propose',
        description:
          'Propose adding shipment tracking (carrier + tracking number) to a PAID order; it is sent to PayPal only after the merchant replies SHIP <code>. ' +
          'Use when the merchant says an order shipped, e.g. "Mark ORD-1042 as shipped with DHL tracking 123456789". Ask for the carrier or tracking number if missing; never invent them.',
        input: z.object({
          order_reference: z.string().trim().min(1).max(40),
          carrier: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .describe('Carrier as said, e.g. DHL, UPS, FedEx, Posta Uganda'),
          tracking_number: z.string().trim().min(1).max(80),
        }),
        async execute({ order_reference, carrier, tracking_number }, ctx) {
          const { payload, order, warnings, traceId } = await deps.shipments.prepare(ctx.merchant, {
            orderReference: order_reference,
            carrier,
            trackingNumber: tracking_number,
          });
          const summary = [
            '*Shipment update*',
            '',
            ...ShipmentService.describe(payload, order),
            ...(warnings.length ? ['', ...warnings.map((w) => `⚠️ ${w}`)] : []),
          ].join('\n');
          const confirmation = await deps.confirmations.propose({
            merchantId: ctx.merchant.id,
            conversationId: ctx.conversation.id,
            action: 'ADD_SHIPMENT_TRACKING',
            payload,
            summary,
            ttlSeconds: deps.confirmationTtlSeconds,
            correlationId: traceId,
          });
          ctx.proposals.push({
            confirmationId: confirmation.id,
            prompt: branded(
              `${summary}\n\n${formatConfirmationPrompt({
                actionDescription: 'update PayPal tracking',
                code: confirmation.code,
                ttlSeconds: deps.confirmationTtlSeconds,
                word: 'SHIP',
              })}`,
            ),
          });
          return {
            order_reference: payload.orderReference,
            status: 'awaiting_merchant_confirmation',
            note: 'The merchant must reply SHIP <code>. Do not say tracking was updated.',
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'remind_customer',
        kind: 'propose',
        description:
          'Propose a polite WhatsApp payment reminder to the customer of an order that is awaiting payment, with its PayPal link. ' +
          'It is sent only after the merchant replies REMIND <code>. Use for "remind Sarah to pay", "chase ORD-1042", "send a payment reminder". ' +
          'Find the order first (find_orders, status AWAITING_PAYMENT) if the merchant names only the customer.',
        input: z.object({ order_reference: z.string().trim().min(1).max(40) }),
        async execute({ order_reference }, ctx) {
          const { payload, summary } = await deps.reminders.prepare(ctx.merchant, order_reference);
          const confirmation = await deps.confirmations.propose({
            merchantId: ctx.merchant.id,
            conversationId: ctx.conversation.id,
            action: 'SEND_PAYMENT_REMINDER',
            payload,
            summary,
            ttlSeconds: deps.confirmationTtlSeconds,
          });
          ctx.proposals.push({
            confirmationId: confirmation.id,
            prompt: branded(
              `${summary}\n\n${formatConfirmationPrompt({
                actionDescription: `send this reminder to ${payload.customerName}`,
                code: confirmation.code,
                ttlSeconds: deps.confirmationTtlSeconds,
                word: 'REMIND',
              })}`,
            ),
          });
          return {
            order_reference: payload.orderReference,
            customer: payload.customerName,
            status: 'awaiting_merchant_confirmation',
            note: 'The merchant must reply REMIND <code>. Do not say the reminder was sent.',
          };
        },
      }),
    )
    // ─── Disputes ──────────────────────────────────────────────────────────
    .register(
      defineTool({
        name: 'list_disputes',
        kind: 'read',
        description:
          'PayPal disputes stored by Katale, with count and total disputed amount. filter: open (default), needs_response (waiting for the merchant), resolved, all. ' +
          'Use for "do I have open disputes?", "which disputes need my attention?", "how much money is disputed?".',
        input: z.object({
          filter: z.enum(['open', 'needs_response', 'resolved', 'all']).default('open'),
        }),
        async execute({ filter }, ctx) {
          const { disputes, totals } = await deps.disputes.list(ctx.merchant.id, filter);
          return {
            filter,
            count: disputes.length,
            disputed_amount: totals.map((t) => t.amount),
            disputes: disputes.slice(0, 20).map((d) => ({
              dispute_id: d.paypalDisputeId,
              order_reference: d.order?.reference ?? null,
              customer: d.order?.customer.name ?? null,
              order_via: d.order ? (d.order.inputMode === 'VOICE' ? 'voice note' : 'text') : null,
              reason: reasonLabel(d.reason),
              status: statusLabel(d.status),
              amount:
                d.amountMinor !== null && d.currency ? money(d.amountMinor, d.currency) : null,
              response_due: d.sellerResponseDueAt?.toISOString() ?? null,
            })),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'get_dispute',
        kind: 'read',
        description:
          "One dispute (by PayPal dispute ID, order reference or customer name) with the buyer's message and the trusted evidence Katale holds: facts, missing evidence and evidence that would be sent. " +
          'Use to review a dispute ("what\'s happening with Sarah\'s dispute?") before drafting a response. Only state facts listed here.',
        input: z.object({ dispute: z.string().trim().min(1).max(120) }),
        async execute({ dispute }, ctx) {
          const d = await deps.disputes.find(ctx.merchant.id, dispute);
          const { facts, missing, evidence } = deps.disputes.evidenceFor(d, ctx.merchant.timezone);
          return {
            dispute_id: d.paypalDisputeId,
            reason: reasonLabel(d.reason),
            status: statusLabel(d.status),
            stage: d.lifecycleStage,
            amount: d.amountMinor !== null && d.currency ? money(d.amountMinor, d.currency) : null,
            response_due: d.sellerResponseDueAt?.toISOString() ?? null,
            buyer_message: d.buyerMessage,
            can_respond_now: d.status === 'WAITING_FOR_SELLER_RESPONSE',
            facts,
            missing_evidence: missing,
            evidence_available: evidence.map((e) => e.label),
            suggested_response: deps.disputes.suggestResponse(d, ctx.merchant.timezone),
            previous_responses: d.responses.map((r) => ({
              status: r.status,
              submitted_at: r.submittedAt?.toISOString() ?? null,
            })),
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'prepare_dispute_response',
        kind: 'propose',
        description:
          "Prepare (NOT send) a response to a PayPal dispute. By default Katale drafts the seller's statement to PayPal from its verified records (order, payment, shipment) — omit response_text. " +
          'Pass response_text only if the merchant asked for different wording; it must contain only facts from get_dispute, and never offer refunds, settlements or accept the claim. ' +
          'Nothing is sent until the merchant replies SUBMIT <code>.',
        input: z.object({
          dispute: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .describe('PayPal dispute ID or order reference'),
          response_text: z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe('Only when the merchant asked for specific wording'),
        }),
        async execute({ dispute, response_text }, ctx) {
          const { dispute: d, payload } = await deps.disputes.prepareResponse(
            ctx.merchant,
            dispute,
            response_text,
          );
          const { missing } = deps.disputes.evidenceFor(d, ctx.merchant.timezone);
          const summary = [
            '*Proposed dispute response*',
            '',
            `Dispute: ${d.paypalDisputeId}${d.order ? ` · Order ${d.order.reference}` : ''}`,
            `Reason: ${reasonLabel(d.reason)}`,
            '',
            `"${payload.responseText}"`,
            '',
            'Evidence:',
            ...payload.evidence.map((e) => `✓ ${e.label}`),
            ...(missing.length ? ['', 'Missing:', ...missing.map((m) => `• ${m}`)] : []),
          ].join('\n');
          if (!canApprove(ctx.operatorRole ?? 'OWNER', 'SUBMIT_DISPUTE_RESPONSE'))
            return needsOwner(
              ctx,
              summary,
              `“prepare a response to dispute ${d.paypalDisputeId}”.`,
            );
          const confirmation = await deps.confirmations.propose({
            merchantId: ctx.merchant.id,
            conversationId: ctx.conversation.id,
            action: 'SUBMIT_DISPUTE_RESPONSE',
            correlationId: d.payment?.correlationId ?? null,
            payload: payload as unknown as Prisma.InputJsonObject,
            summary,
            ttlSeconds: deps.confirmationTtlSeconds,
          });
          ctx.proposals.push({
            confirmationId: confirmation.id,
            prompt: branded(
              `${summary}\n\n${formatConfirmationPrompt({
                actionDescription: 'send this response to PayPal',
                code: confirmation.code,
                ttlSeconds: deps.confirmationTtlSeconds,
                word: 'SUBMIT',
              })}`,
            ),
          });
          return {
            dispute_id: d.paypalDisputeId,
            status: 'awaiting_merchant_confirmation',
            note: 'The merchant must reply SUBMIT <code>. Nothing has been sent to PayPal.',
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'refresh_disputes',
        kind: 'read',
        description:
          'Re-read all disputes from PayPal (use if the merchant says a dispute is missing or out of date).',
        input: z.object({}),
        async execute(_input, ctx) {
          const count = await deps.disputes.refresh();
          const { disputes } = await deps.disputes.list(ctx.merchant.id, 'open');
          return { synced_from_paypal: count, open_disputes: disputes.length };
        },
      }),
    )
    // ─── Inventory & catalog ───────────────────────────────────────────────
    .register(
      defineTool({
        name: 'inventory_report',
        kind: 'read',
        description:
          'Stock position of every product: units in stock, reorder level, status (OK, LOW, OUT_OF_STOCK, NOT_TRACKED), units sold in the last 30 days, ' +
          'estimated days of cover and a suggested reorder quantity (estimates from average daily sales). Use for "which products are running low?", "what should I reorder?", "inventory summary".',
        input: z.object({ filter: z.enum(['all', 'low', 'out']).default('all') }),
        async execute({ filter }, ctx) {
          const rows = await deps.inventory.report(ctx.merchant.id);
          const picked =
            filter === 'low'
              ? rows.filter((r) => r.status === 'LOW' || r.status === 'OUT_OF_STOCK')
              : filter === 'out'
                ? rows.filter((r) => r.status === 'OUT_OF_STOCK')
                : rows;
          return {
            filter,
            products: picked,
            note: 'days_of_cover and suggested_reorder are estimates from paid orders in the last 30 days.',
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'stock_history',
        kind: 'read',
        description:
          'Recent stock movements (sales, restocks, corrections), optionally for one product.',
        input: z.object({
          product: z.string().trim().min(1).max(120).optional(),
          limit: z.number().int().min(1).max(30).default(10),
        }),
        async execute({ product, limit }, ctx) {
          const moves = await deps.inventory.movements(ctx.merchant.id, product, limit);
          return moves.map((m) => ({
            product: m.product.name,
            type: m.type,
            change: m.quantity,
            balance_after: m.balanceAfter,
            note: m.note,
            at: m.createdAt.toISOString(),
          }));
        },
      }),
    )
    .register(
      defineTool({
        name: 'adjust_stock',
        kind: 'write',
        description:
          'Record a stock change the merchant reports: restock ("add 50 baskets"), a count ("I have 40 wallets", use set_to), damage or a return. ' +
          'Use change for +/- units or set_to for a counted total — never both. Sales reduce stock automatically when a payment completes; do not use this for sales.',
        input: z.object({
          product: z.string().trim().min(1).max(120),
          change: z.number().int().min(-100_000).max(100_000).optional(),
          set_to: z.number().int().min(0).max(1_000_000).optional(),
          reason: z.enum(['restock', 'count', 'damaged', 'return']),
          note: z.string().max(200).optional(),
        }),
        async execute({ product, change, set_to, reason, note }, ctx) {
          const type =
            reason === 'restock'
              ? 'RESTOCK'
              : reason === 'damaged'
                ? 'DAMAGED'
                : reason === 'return'
                  ? 'RETURN'
                  : 'ADJUSTMENT';
          const result = await deps.inventory.adjust({
            merchantId: ctx.merchant.id,
            product,
            change: reason === 'damaged' && change !== undefined ? -Math.abs(change) : change,
            setTo: set_to,
            type,
            note,
          });
          return {
            product: result.product.name,
            before: result.before,
            after: result.after,
            reorder_level: result.product.reorderLevel,
            status_after:
              result.alert?.status ??
              (result.product.reorderLevel !== null && result.after <= result.product.reorderLevel
                ? 'LOW'
                : 'OK'),
            recorded: true,
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'add_product',
        kind: 'write',
        description:
          'Add a product to the catalog with its price, and optionally opening stock and a reorder level. Only when the merchant asks to add a product. Never invent the price.',
        input: z.object({
          name: z.string().trim().min(2).max(120),
          price: z.number().positive().max(1_000_000),
          sku: z.string().trim().max(40).optional(),
          stock: z.number().int().min(0).max(1_000_000).optional(),
          reorder_level: z.number().int().min(0).max(1_000_000).optional(),
        }),
        async execute(input, ctx) {
          if (ctx.fromVoice)
            throw new ValidationError(
              'Prices from voice notes can be misheard. Ask the merchant to type the new product and price.',
            );
          const currency = normalizeCurrency(ctx.merchant.preferredCurrency);
          const created = await deps.products.create(ctx.merchant.id, {
            name: input.name,
            sku: input.sku ?? null,
            currency,
            unitPriceMinor: toMinorUnits(input.price, currency),
            stockQuantity: null,
          });
          if (input.reorder_level !== undefined)
            await deps.inventory.setReorderLevel(
              ctx.merchant.id,
              created.name,
              input.reorder_level,
            );
          if (input.stock !== undefined)
            await deps.inventory.adjust({
              merchantId: ctx.merchant.id,
              product: created.name,
              setTo: input.stock,
              type: 'RESTOCK',
              note: 'Opening stock',
            });
          return {
            added: created.name,
            price: money(created.unitPriceMinor, currency),
            stock: input.stock ?? 'not tracked',
            reorder_level: input.reorder_level ?? null,
          };
        },
      }),
    )
    .register(
      defineTool({
        name: 'update_product',
        kind: 'write',
        description:
          "Change a product's price, reorder level, or active/inactive status. Price changes apply to new orders only. Only when the merchant asks.",
        input: z.object({
          product: z.string().trim().min(1).max(120),
          price: z.number().positive().max(1_000_000).optional(),
          reorder_level: z.number().int().min(0).max(1_000_000).nullable().optional(),
          active: z.boolean().optional(),
        }),
        async execute({ product, price, reorder_level, active }, ctx) {
          if (price !== undefined && ctx.fromVoice)
            throw new ValidationError(
              'Prices from voice notes can be misheard. Ask the merchant to type the new price.',
            );
          const target = await deps.inventory.resolve(ctx.merchant.id, product);
          const updated = await deps.products.update(ctx.merchant.id, target.id, {
            ...(price !== undefined
              ? { unitPriceMinor: toMinorUnits(price, target.currency) }
              : {}),
            ...(active !== undefined ? { active } : {}),
          });
          if (reorder_level !== undefined)
            await deps.inventory.setReorderLevel(
              ctx.merchant.id,
              target.id === updated.id ? updated.name : product,
              reorder_level,
            );
          return {
            product: updated.name,
            price: money(updated.unitPriceMinor, updated.currency),
            previous_price: money(target.unitPriceMinor, target.currency),
            active: updated.active,
            reorder_level: reorder_level === undefined ? updated.reorderLevel : reorder_level,
          };
        },
      }),
    )
    // ─── Analytics ─────────────────────────────────────────────────────────
    .register(
      defineTool({
        name: 'compare_sales',
        kind: 'read',
        description:
          'Compare revenue and paid orders for a period with the same elapsed time in the previous period (e.g. this week so far vs last week so far), with the % change computed by the backend. ' +
          'Use for "how does this week compare to last week?", "am I doing better than last month?".',
        input: z.object({ period: salesPeriodSchema.exclude(['all_time']) }),
        async execute({ period }, ctx) {
          return deps.analytics.compareSales(ctx.merchant, period);
        },
      }),
    )
    .register(
      defineTool({
        name: 'send_chart',
        kind: 'read',
        description:
          "Send the merchant a chart image on WhatsApp, drawn from Katale's records: revenue_trend (revenue per day, days 7 or 30), product_revenue (revenue by product for a period), stock_levels (stock vs reorder level). " +
          'Use when the merchant asks for a graph, chart or visual report. Reply with one short sentence; the image is attached automatically.',
        input: z.object({
          chart: z.enum(['revenue_trend', 'product_revenue', 'stock_levels']),
          days: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
          period: salesPeriodSchema.optional(),
        }),
        async execute({ chart, days, period }, ctx) {
          const result = await deps.reports.chart(chart, ctx.merchant, {
            ...(days ? { days } : {}),
            ...(period ? { period } : {}),
          });
          ctx.attachments ??= [];
          ctx.attachments.push({ media: result.media, caption: result.caption });
          return { chart_attached: true, caption: result.caption, figures: result.data };
        },
      }),
    )
    .register(
      defineTool({
        name: 'get_sales_summary',
        kind: 'read',
        description:
          'Sales for a period from completed PayPal payments: revenue, paid orders, average order value, ' +
          'best-selling products (by revenue, with share), top customers, revenue by source ' +
          '(WhatsApp voice / WhatsApp text / Agent console) and the current outstanding amount. ' +
          'Use for "how much have I sold", "best-selling product", "top customers", "how much did voice orders generate", "how much is outstanding".',
        input: z.object({ period: salesPeriodSchema }),
        async execute({ period }, ctx) {
          return deps.analytics.salesSummary(ctx.merchant, period);
        },
      }),
    );

  return registry;
}
