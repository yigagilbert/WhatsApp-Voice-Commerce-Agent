/**
 * EXTERNAL — real LLM: the merchant questions Katale AI must answer from trusted tools
 * (catalog, customers, orders, payments, analytics), never from memory or chat history.
 * Lookup tools return canned data (tests/support/interpret.ts); no database or PayPal.
 *
 * Run: pnpm test:external
 */
import { describe, expect, it } from 'vitest';
import { aiConfig as config, args, interpret } from '../support/interpret';

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

describe.skipIf(!config.AI_API_KEY)(`Merchant questions (${config.AI_MODEL})`, () => {
  it.each([
    ['What products do I have?', ['list_products']],
    ['How much is a handmade basket?', ['find_product', 'list_products', 'check_inventory']],
    ['Do I have coffee gift packs?', ['find_product', 'list_products', 'check_inventory']],
  ])('catalog: %s', async (question, expected) => {
    const { calls } = await interpret(question);
    expect(
      names(calls).some((n) => expected.includes(n)),
      names(calls).join(', '),
    ).toBe(true);
  });

  it.each([['Who is Sarah?'], ['How many orders has Sarah made?'], ['How much has Sarah spent?']])(
    'customers: %s',
    async (question) => {
      const { calls, text } = await interpret(question);
      expect(names(calls)).toContain('get_customer_summary');
      if (/spent/.test(question)) expect(text).toContain('140');
    },
  );

  it("orders: which orders haven't been paid → find_orders(AWAITING_PAYMENT)", async () => {
    const { calls, text } = await interpret("Which orders haven't been paid?");
    expect(args(calls.find((c) => c.name === 'find_orders'))).toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
    expect(text).toMatch(/ORD-JC5BSK|James/);
  });

  it("orders: show me today's orders → find_orders(today)", async () => {
    const { calls } = await interpret("Show me today's orders.");
    expect(args(calls.find((c) => c.name === 'find_orders'))).toMatchObject({ period: 'today' });
  });

  it('orders: how many are waiting for payment → database count', async () => {
    const { calls, text } = await interpret('How many orders are waiting for payment?');
    expect(names(calls)).toContain('find_orders');
    expect(text).toMatch(/\b(1|one)\b/i);
  });

  it('orders: status of a reference → get_order / get_payment_status', async () => {
    const { calls } = await interpret("What's the status of ORD-ST10HB?");
    expect(names(calls).some((n) => n === 'get_order' || n === 'get_payment_status')).toBe(true);
  });

  it('payments: has Sarah paid → answered from tools, not chat', async () => {
    const { calls, text } = await interpret('Has Sarah paid?');
    expect(
      names(calls).some((n) =>
        ['find_orders', 'get_customer_summary', 'list_payments', 'get_payment_status'].includes(n),
      ),
      names(calls).join(', '),
    ).toBe(true);
    expect(text.toLowerCase()).toMatch(/paid|140/);
  });

  it('payments: what was my last payment → list_payments', async () => {
    const { calls, text } = await interpret('What was my last payment?');
    expect(names(calls)).toContain('list_payments');
    expect(text).toContain('140');
  });

  it('payments: how much did I receive today → get_sales_summary(today)', async () => {
    const { calls } = await interpret('How much did I receive today?');
    expect(args(calls.find((c) => c.name === 'get_sales_summary'))).toMatchObject({
      period: 'today',
    });
  });

  it.each([
    ['What is my best-selling product?', 'Handmade Basket'],
    ['Who are my top customers?', 'Sarah'],
    ['How much money is still outstanding?', '60'],
    ['How much did voice orders generate?', '140'],
  ])('analytics: %s', async (question, expected) => {
    const { calls, text } = await interpret(question);
    expect(
      names(calls).some((n) => n === 'get_sales_summary' || n === 'find_orders'),
      names(calls).join(', '),
    ).toBe(true);
    expect(text).toContain(expected);
  });
});
