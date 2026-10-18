/**
 * EXTERNAL — real LLM: shipment and dispute requests pick the right tools, pass the merchant's
 * values exactly, and dispute drafts use only the facts get_dispute returned (no refunds/offers).
 * Tools return canned data (tests/support/interpret.ts); nothing reaches a database or PayPal.
 *
 * Run: pnpm test:external
 */
import { describe, expect, it } from 'vitest';
import { aiConfig as config, args, interpret } from '../support/interpret';

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

describe.skipIf(!config.AI_API_KEY)(`Shipments and disputes (${config.AI_MODEL})`, () => {
  it.each([
    'Mark ORD-1042 as shipped with DHL tracking 123456789.',
    'Order ORD-1042 shipped today with DHL. Tracking number 123456789.',
  ])('shipment: %s → add_shipment_tracking with the exact values', async (message) => {
    const { calls } = await interpret(message);
    expect(args(calls.find((c) => c.name === 'add_shipment_tracking'))).toMatchObject({
      order_reference: 'ORD-1042',
      carrier: expect.stringMatching(/dhl/i),
      tracking_number: expect.stringMatching(/^123456789$/),
    });
  });

  it.each([
    ['Remind James Carter to pay for ORD-JC5BSK.', 'ORD-JC5BSK'],
    ['Send a payment reminder for ORD-JC5BSK', 'ORD-JC5BSK'],
    ['Can you chase James? He still hasn’t paid.', 'ORD-JC5BSK'],
  ])('reminder: %s → remind_customer', async (message, reference) => {
    const { calls } = await interpret(message);
    expect(args(calls.find((c) => c.name === 'remind_customer'))).toMatchObject({
      order_reference: reference,
    });
  });

  it('does not propose a reminder for a paid order', async () => {
    const { calls } = await interpret('Remind Sarah to pay for her order.');
    expect(names(calls)).not.toContain('remind_customer');
  });

  it('asks for the tracking number instead of inventing one', async () => {
    const { calls, text } = await interpret('ORD-1042 has shipped with DHL.');
    expect(names(calls)).not.toContain('add_shipment_tracking');
    expect(text.toLowerCase()).toMatch(/tracking/);
  });

  it.each([
    ["What's the tracking number for ORD-ST10HB?", '123456789'],
    ['Where is ORD-ST10HB?', 'DHL'],
  ])('tracking question: %s', async (question, expected) => {
    const { calls, text } = await interpret(question);
    expect(names(calls)).toContain('get_shipping_status');
    expect(text).toContain(expected);
    expect(text.toLowerCase()).not.toMatch(/\bwas delivered\b|\bhas been delivered\b/);
  });

  it('which paid orders still need shipping → find_orders(PAID, NOT_SHIPPED)', async () => {
    const { calls } = await interpret('Which paid orders still need shipping?');
    expect(args(calls.find((c) => c.name === 'find_orders'))).toMatchObject({
      status: 'PAID',
      fulfillment: 'NOT_SHIPPED',
    });
  });

  it.each([
    ['Do I have any open disputes?', /PP-D-12345|Sarah|ORD-ST10HB/],
    ['Which disputes need my attention?', /PP-D-12345|Sarah|ORD-ST10HB/],
    ['How much money is currently disputed?', /140/],
  ])('disputes: %s', async (question, expected) => {
    const { calls, text } = await interpret(question);
    expect(names(calls)).toContain('list_disputes');
    expect(text).toMatch(expected);
  });

  it("reviews Sarah's dispute from trusted facts, separating facts and missing evidence", async () => {
    const { calls, text } = await interpret("What's happening with Sarah's dispute?");
    expect(names(calls)).toContain('get_dispute');
    expect(text).toContain('123456789');
    expect(text.toLowerCase()).toMatch(/missing|delivery/);
  });

  it('drafts a factual response with prepare_dispute_response — no refunds, no invented facts', async () => {
    const { calls } = await interpret(
      "Review Sarah's dispute PP-D-12345 and prepare a response to PayPal using the evidence.",
    );
    const draft = args(calls.find((c) => c.name === 'prepare_dispute_response'));
    expect(draft, names(calls).join(', ')).toBeDefined();
    expect(draft.dispute).toMatch(/PP-D-12345|ORD-ST10HB/);
    // Default: no text from the model — Katale drafts from its records. Custom text, if any,
    // must not concede and may only cite references from the facts (the backend re-checks too).
    const text: string = draft.response_text ?? '';
    expect(text).not.toMatch(/refund|offer|settle|accept/i);
    const facts = 'ORD-ST10HB 8MC585209K746392H 123456789 PP-D-12345';
    for (const token of text.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}\b/gi) ?? [])
      expect(facts).toContain(token.toUpperCase());
  });
});
