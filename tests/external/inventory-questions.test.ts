/**
 * EXTERNAL — real LLM: inventory, catalog, comparison and chart requests choose the right tool and
 * pass the merchant's numbers exactly. Tools return canned data (tests/support/interpret.ts).
 *
 * Run: pnpm test:external
 */
import { describe, expect, it } from 'vitest';
import { aiConfig as config, args, interpret } from '../support/interpret';

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

describe.skipIf(!config.AI_API_KEY)(
  `Inventory, charts and comparisons (${config.AI_MODEL})`,
  () => {
    it.each([
      ['Which products are running low?', /Handmade Basket/],
      ['What should I reorder?', /Coffee Gift Pack|Handmade Basket/],
    ])('inventory: %s → inventory_report', async (question, expected) => {
      const { calls, text } = await interpret(question);
      expect(names(calls)).toContain('inventory_report');
      expect(text).toMatch(expected);
    });

    it('restock: "I just received 50 baskets" → adjust_stock(+50, restock)', async () => {
      const { calls } = await interpret('I just received 50 baskets.');
      expect(args(calls.find((c) => c.name === 'adjust_stock'))).toMatchObject({
        product: expect.stringMatching(/basket/i),
        change: 50,
        reason: 'restock',
      });
    });

    it('count: "I counted 40 wallets" → adjust_stock(set_to 40)', async () => {
      const { calls } = await interpret('I counted my stock: I have 40 barkcloth wallets.');
      const a = args(calls.find((c) => c.name === 'adjust_stock'));
      expect(a).toMatchObject({ set_to: 40 });
      expect(a.change).toBeUndefined();
    });

    it('new product → add_product with the stated price', async () => {
      const { calls } = await interpret('Add a new product: Kitenge Tote, $22.50 each, I have 10.');
      expect(args(calls.find((c) => c.name === 'add_product'))).toMatchObject({
        name: expect.stringMatching(/kitenge tote/i),
        price: 22.5,
        stock: 10,
      });
    });

    it('price change → update_product', async () => {
      const { calls } = await interpret('Change the price of handmade baskets to $14.');
      expect(args(calls.find((c) => c.name === 'update_product'))).toMatchObject({ price: 14 });
    });

    it('does not use adjust_stock for a sale (sales reduce stock automatically)', async () => {
      const { calls } = await interpret('Create an order for Sarah for 5 handmade baskets.');
      expect(names(calls)).toContain('create_draft_order');
      expect(names(calls)).not.toContain('adjust_stock');
    });

    it.each([
      ['Send me a chart of my sales for the last 7 days.', { chart: 'revenue_trend' }],
      ['Show me a graph of revenue by product.', { chart: 'product_revenue' }],
      ['Can I see my stock levels as a chart?', { chart: 'stock_levels' }],
    ])('chart: %s', async (question, expected) => {
      const { calls } = await interpret(question);
      expect(args(calls.find((c) => c.name === 'send_chart'))).toMatchObject(expected);
    });

    it('comparison: "How does this week compare to last week?" → compare_sales with backend %', async () => {
      const { calls, text } = await interpret('How does this week compare to last week?');
      expect(args(calls.find((c) => c.name === 'compare_sales'))).toMatchObject({
        period: 'this_week',
      });
      expect(text).toMatch(/40\s?%/);
      expect(text).toContain('420');
    });
  },
);
