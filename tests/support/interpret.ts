/**
 * Real-LLM interpretation harness shared by the external suites: runs the configured model with the
 * real system prompt and tool schemas; lookup tools return canned catalog data, and the loop stops
 * at the first "terminal" (order/payment) tool so nothing touches a database or PayPal.
 */
import { OpenAICompatibleChatModel, type ChatMessage, type ToolCall } from '@vca/ai';
import { aiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { buildSystemPrompt } from '../../apps/api/src/modules/agent/system-prompt';
import { createCommerceTools, type ToolDeps } from '../../apps/api/src/modules/agent/tools';

type Merchant = Parameters<typeof buildSystemPrompt>[0]['merchant'];

loadEnvFile();
export const aiConfig = parseConfig(aiSchema);
const config = aiConfig;

const merchant = {
  id: 'm1',
  businessName: 'Kampala Crafts',
  ownerName: 'Owner',
  ownerEmail: null,
  preferredCurrency: 'USD',
  preferredLanguage: 'en',
  timezone: 'Africa/Kampala',
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Merchant;

// Only `specs()` is used — tool implementations are replaced by canned results below.
export const specs = createCommerceTools({} as ToolDeps).specs();

const CANNED: Record<string, unknown> = {
  find_customer: [
    { id: 'cust_sarah', name: 'Sarah Thompson', email: 'sarah.thompson@example.com' },
  ],
  list_products: [
    { id: 'prod_basket', name: 'Handmade Basket', price: '$12.00', stock: 200 },
    { id: 'prod_wallet', name: 'Barkcloth Wallet', price: '$18.00', stock: 80 },
    { id: 'prod_coffee', name: 'Coffee Gift Pack', price: '$25.00', stock: 120 },
  ],
  find_product: [{ id: 'prod_basket', name: 'Handmade Basket', price: '$12.00', stock: 200 }],
  // (Coffee Gift Pack is in list_products below for "do I have…" questions.)
  check_inventory: [{ name: 'Handmade Basket', stock: 200 }],
  get_sales_summary: {
    period: 'this_week',
    label: 'this week (since Monday)',
    revenue: [{ currency: 'USD', amountMinor: 17600, formatted: '$176.00', count: 2 }],
    outstanding: [{ currency: 'USD', amountMinor: 6000, formatted: '$60.00', count: 1 }],
    paidOrders: 2,
    averageOrderValue: [{ currency: 'USD', amountMinor: 8800, formatted: '$88.00' }],
    topProducts: [
      { name: 'Handmade Basket', quantity: 10, formatted: '$120.00', sharePercent: 76.9 },
      { name: 'Barkcloth Wallet', quantity: 2, formatted: '$36.00', sharePercent: 23.1 },
    ],
    topCustomers: [
      { name: 'Sarah Thompson', orders: 1, formatted: '$140.00' },
      { name: 'James Carter', orders: 1, formatted: '$36.00' },
    ],
    bySource: [
      { name: 'WhatsApp voice', orders: 1, formatted: '$140.00' },
      { name: 'WhatsApp text', orders: 1, formatted: '$36.00' },
    ],
  },
  // Orders filtered by customer return that customer's order (Sarah: paid; anyone else: unpaid).
  find_orders: (a: { customer?: string }) =>
    /sarah/i.test(a.customer ?? '')
      ? {
          period: null,
          count: 1,
          total_value: ['$140.00'],
          showing: 1,
          orders: [
            {
              reference: 'ORD-ST10HB',
              customer: 'Sarah Thompson',
              status: 'PAID',
              total: '$140.00',
              items: '10 × Handmade Basket',
              via: 'voice note',
              created_at: '2026-10-07T08:00:00.000Z',
            },
          ],
        }
      : FIND_ORDERS_UNPAID,
};
const FIND_ORDERS_UNPAID = {
  period: null,
  count: 1,
  total_value: ['$60.00'],
  showing: 1,
  orders: [
    {
      reference: 'ORD-JC5BSK',
      customer: 'James Carter',
      status: 'AWAITING_PAYMENT',
      total: '$60.00',
      items: '5 × Handmade Basket',
      via: 'text',
      created_at: '2026-10-07T09:00:00.000Z',
    },
  ],
};
Object.assign(CANNED, {
  inventory_report: {
    filter: 'all',
    products: [
      {
        name: 'Handmade Basket',
        stock: 18,
        reorderLevel: 30,
        status: 'LOW',
        unitsSoldLastPeriod: 60,
        periodDays: 30,
        daysOfCover: 9,
        suggestedReorder: 72,
      },
      {
        name: 'Barkcloth Wallet',
        stock: 80,
        reorderLevel: 15,
        status: 'OK',
        unitsSoldLastPeriod: 4,
        periodDays: 30,
        daysOfCover: 600,
        suggestedReorder: 0,
      },
      {
        name: 'Coffee Gift Pack',
        stock: 0,
        reorderLevel: 20,
        status: 'OUT_OF_STOCK',
        unitsSoldLastPeriod: 12,
        periodDays: 30,
        daysOfCover: 0,
        suggestedReorder: 32,
      },
    ],
    note: 'days_of_cover and suggested_reorder are estimates from paid orders in the last 30 days.',
  },
  compare_sales: {
    period: 'this week (since Monday)',
    comparedWith: 'last week (same days)',
    byCurrency: [
      {
        currency: 'USD',
        revenue: '$420.00',
        previousRevenue: '$300.00',
        paidOrders: 4,
        previousPaidOrders: 3,
        changePercent: 40,
        change: '$120.00',
      },
    ],
  },
  get_shipping_status: {
    order_reference: 'ORD-ST10HB',
    customer: 'Sarah Thompson',
    payment: 'paid',
    fulfillment: 'shipped',
    shipments: [
      {
        carrier: 'DHL',
        tracking_number: '123456789',
        status: 'SHIPPED',
        shipped_at: '2026-10-08T09:00:00.000Z',
        registered_with_paypal: true,
      },
    ],
    note: 'PayPal tracking has no delivered status; Katale does not know delivery dates.',
  },
  list_shipments: [
    {
      order_reference: 'ORD-ST10HB',
      customer: 'Sarah Thompson',
      carrier: 'DHL',
      tracking_number: '123456789',
      status: 'SHIPPED',
      shipped_at: '2026-10-08T09:00:00.000Z',
    },
  ],
  list_disputes: {
    filter: 'open',
    count: 1,
    disputed_amount: ['$140.00'],
    disputes: [
      {
        dispute_id: 'PP-D-12345',
        order_reference: 'ORD-ST10HB',
        customer: 'Sarah Thompson',
        order_via: 'voice note',
        reason: 'Item not received',
        status: 'Needs your response',
        amount: '$140.00',
        response_due: '2026-10-15T00:00:00.000Z',
      },
    ],
  },
  get_dispute: {
    dispute_id: 'PP-D-12345',
    reason: 'Item not received',
    status: 'Needs your response',
    amount: '$140.00',
    response_due: '2026-10-15T00:00:00.000Z',
    buyer_message: 'I never received my baskets.',
    can_respond_now: true,
    facts: [
      { label: 'Order', value: 'ORD-ST10HB for Sarah Thompson, created 7 Oct 2026' },
      { label: 'Items', value: '10 × Handmade Basket ($120.00)' },
      { label: 'Order total', value: '$140.00' },
      {
        label: 'Payment',
        value: '$140.00 captured by PayPal on 7 Oct 2026 (capture 8MC585209K746392H)',
      },
      {
        label: 'Shipment',
        value: 'Shipped 8 Oct 2026 with DHL, tracking 123456789 (tracking registered with PayPal)',
      },
    ],
    missing_evidence: [
      'Proof of delivery: Katale has the tracking number but no delivery confirmation.',
    ],
    evidence_available: ['Order details', 'Payment confirmation', 'Shipment tracking'],
    previous_responses: [],
    suggested_response:
      'Order ORD-ST10HB (10 × Handmade Basket, total $140.00) was paid through PayPal on 7 Oct 2026. It was shipped on 8 Oct 2026 with DHL, tracking number 123456789, which is registered with PayPal. We ask PayPal to review the tracking information for this shipment.',
  },
  list_payments: [
    {
      order_reference: 'ORD-ST10HB',
      customer: 'Sarah Thompson',
      status: 'COMPLETED',
      amount: '$140.00',
      requested_at: '2026-10-07T08:00:00.000Z',
      paid_at: '2026-10-07T08:03:00.000Z',
    },
  ],
  get_customer_summary: [
    {
      name: 'Sarah Thompson',
      email: 'sarah.thompson@example.com',
      country: 'US',
      orders_total: 1,
      orders_paid: 1,
      orders_awaiting_payment: 0,
      total_paid: ['$140.00'],
      outstanding: [],
      last_order: { reference: 'ORD-ST10HB', status: 'PAID', total: '$140.00' },
    },
  ],
  get_order: {
    reference: 'ORD-ST10HB',
    status: 'PAID',
    customer: 'Sarah Thompson',
    total: '$140.00',
    payments: [{ status: 'COMPLETED', amount: '$140.00' }],
  },
  get_payment_status: {
    order_reference: 'ORD-ST10HB',
    order_status: 'PAID',
    payment_status: 'COMPLETED',
    amount: '$140.00',
  },
});
const TERMINAL = new Set([
  'adjust_stock',
  'add_product',
  'update_product',
  'send_chart',
  'create_draft_order',
  'calculate_order_total',
  'request_payment',
  'add_shipment_tracking',
  'remind_customer',
  'prepare_dispute_response',
]);

/** Runs the model until it calls a terminal tool or answers in text. */
export async function interpret(
  userMessage: string,
  options: { fromVoice?: boolean; messageLanguage?: string } = {},
) {
  const model = new OpenAICompatibleChatModel({
    baseUrl: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY!,
    model: config.AI_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ merchant, now: new Date(), ...options }) },
    { role: 'user', content: userMessage },
  ];
  const calls: ToolCall[] = [];
  for (let step = 0; step < 6; step++) {
    const { message } = await model.complete({ messages, tools: specs });
    messages.push(message);
    if (!message.toolCalls?.length) return { calls, text: message.content ?? '' };
    for (const call of message.toolCalls) {
      calls.push(call);
      if (TERMINAL.has(call.name)) return { calls, text: '' };
      const canned = CANNED[call.name] ?? [];
      const data =
        typeof canned === 'function'
          ? (canned as (a: unknown) => unknown)(JSON.parse(call.arguments || '{}'))
          : canned;
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({ ok: true, data }),
      });
    }
  }
  return { calls, text: '' };
}

export const args = (call: ToolCall | undefined) => (call ? JSON.parse(call.arguments) : undefined);
