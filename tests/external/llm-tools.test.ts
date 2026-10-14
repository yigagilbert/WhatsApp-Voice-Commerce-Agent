/**
 * EXTERNAL — real LLM via the configured OpenAI-compatible endpoint. Checks that the model
 * picks the right tools with the real tool schemas and system prompt, and asks for
 * clarification instead of inventing values. Lookup tools are answered with canned data so
 * no database is needed; nothing is executed against PayPal.
 */
import { describe, expect, it } from 'vitest';
import { aiConfig as config, args, interpret, specs } from '../support/interpret';

describe.skipIf(!config.AI_API_KEY)(`Real LLM tool calling (${config.AI_MODEL})`, () => {
  it('produces OpenAI-valid tool schemas', () => {
    for (const spec of specs) expect(spec.parameters).toMatchObject({ type: 'object' });
  });

  it('A: drafts an order with stated quantity and price', async () => {
    const { calls } = await interpret(
      'Create an order for Sarah for 10 handmade baskets at $12 each.',
    );
    const draft = calls.find((c) => c.name === 'create_draft_order');
    expect(draft, `tools called: ${calls.map((c) => c.name).join(', ')}`).toBeDefined();
    const a = args(draft);
    expect(a.customer.name).toMatch(/sarah/i);
    expect(a.items).toHaveLength(1);
    expect(a.items[0]).toMatchObject({ quantity: 10, unit_price: 12 });
  });

  it('B: drafts with catalog price and shipping when no price is stated', async () => {
    const { calls, text } = await interpret('Sarah wants 20 baskets. Add $25 shipping.');
    const a = args(calls.find((c) => c.name === 'create_draft_order'));
    expect(
      a,
      `tools: ${calls.map((c) => `${c.name}(${c.arguments})`).join(', ')} | text: ${text}`,
    ).toBeDefined();
    expect(a.items[0].quantity).toBe(20);
    expect(a.shipping).toBe(25);
    // Price not stated → the backend catalog must decide it.
    expect(a.items[0].unit_price === undefined || a.items[0].unit_price === 12).toBe(true);
  });

  it('C: answers sales questions via get_sales_summary(this_week)', async () => {
    const { calls, text } = await interpret('How much have I sold this week?');
    expect(args(calls.find((c) => c.name === 'get_sales_summary'))).toMatchObject({
      period: 'this_week',
    });
    expect(text).toContain('176');
  });

  it('D: passes a suspicious stated price through unchanged (backend flags/limits it)', async () => {
    const { calls } = await interpret('Create an order for Sarah for 10 baskets at $1000 each.');
    const a = args(calls.find((c) => c.name === 'create_draft_order'));
    expect(a.items[0]).toMatchObject({ quantity: 10, unit_price: 1000 });
  });

  it('asks for the quantity instead of inventing one', async () => {
    const { calls, text } = await interpret('Create an order for Sarah for some baskets.');
    expect(calls.some((c) => c.name === 'create_draft_order')).toBe(false);
    expect(text.toLowerCase()).toMatch(/how many|quantity/);
  });
});
