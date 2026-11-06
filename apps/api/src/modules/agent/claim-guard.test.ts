import { describe, expect, it } from 'vitest';
import { CUSTOMER_CLAIMS, MERCHANT_CLAIMS, checkClaims, type CheckedStep } from './claim-guard';

const ok = (tool: string): CheckedStep => ({ tool, result: { ok: true, data: {} } });
const failed = (tool: string): CheckedStep => ({
  tool,
  result: { ok: false, code: 'X', error: 'no' },
});

describe('merchant claim guard', () => {
  it.each([
    'I updated the draft order to include $20 shipping.',
    "I've added $20 shipping to the order.",
    'Shipping has been added to your draft.',
    'Updated the draft order.',
    'I changed the price of the wallet to $5.',
    'I have recorded 20 units of stock.',
    'I have sent the message to Sarah.',
    'The payment link was sent to Sarah.',
    'I cancelled the order.',
    'Tracking was updated with PayPal.',
    'I resumed the chat with Sarah.',
  ])('blocks %s with no tool call', (reply) => {
    expect(checkClaims(reply, [], MERCHANT_CLAIMS).ok).toBe(false);
  });

  it('blocks approval codes in model text even after a successful tool', () => {
    const reply =
      '*Draft order ORD-2V7X9M*\nShipping — $20.00\n*Total — $44.00*\nReply *CONFIRM 6821*';
    expect(checkClaims(reply, [ok('create_draft_order')], MERCHANT_CLAIMS)).toEqual({
      ok: false,
      claim: 'approval_code',
    });
    expect(checkClaims('Reply CANCEL ORDER 1234', [], MERCHANT_CLAIMS).ok).toBe(false);
  });

  it('blocks a summary with a total when no order tool ran', () => {
    const reply = '*Draft order ORD-2V7X9M*\nShipping — $20.00\n*Total — $44.00*';
    expect(checkClaims(reply, [], MERCHANT_CLAIMS)).toEqual({ ok: false, claim: 'order_summary' });
  });

  it('a failed tool does not back a claim', () => {
    expect(
      checkClaims('I updated the draft order.', [failed('update_draft_order')], MERCHANT_CLAIMS).ok,
    ).toBe(false);
  });

  it.each([
    ['I updated the draft order.', 'update_draft_order'],
    ['I changed the price of the wallet to $5.', 'update_product'],
    ['I have recorded 20 units of stock.', 'adjust_stock'],
    ['I have sent the message to Sarah.', 'reply_to_customer'],
    ['The payment link was sent on Tuesday.', 'get_order'],
  ])('allows %s after %s succeeded', (reply, tool) => {
    expect(checkClaims(reply, [ok(tool)], MERCHANT_CLAIMS).ok).toBe(true);
  });

  it.each([
    'Would you like me to update the draft order?',
    "I can't change the price here.",
    'I have not updated the order.',
    'You have 12 baskets in stock. Would you like to add more?',
    'Which product should I add stock for?',
    'Sales are up 12% this week.',
    'Hi! How can I help with the shop today?',
    'I will add it once you tell me the quantity.',
  ])('does not block %s', (reply) => {
    expect(checkClaims(reply, [], MERCHANT_CLAIMS).ok).toBe(true);
  });
});

describe('customer claim guard', () => {
  it.each([
    'Got it! Delivery address set to: Plot 12 Kampala Road.',
    'Your address has been updated.',
    'Your order has been placed!',
    'Your payment was received, thank you.',
    'Your order has been shipped.',
    "I've added the basket to your cart.",
  ])('blocks %s with no tool call', (reply) => {
    expect(checkClaims(reply, [], CUSTOMER_CLAIMS).ok).toBe(false);
  });

  it('allows them when the tool ran', () => {
    expect(
      checkClaims('Your address has been updated.', [ok('change_delivery')], CUSTOMER_CLAIMS).ok,
    ).toBe(true);
    expect(checkClaims('Your order has been shipped.', [ok('my_orders')], CUSTOMER_CLAIMS).ok).toBe(
      true,
    );
  });

  it.each([
    'We sell baskets and wallets.',
    'What address should we deliver to?',
    'You can place your order by replying ORDER.',
    'Delivery in Kampala costs $5.',
  ])('does not block %s', (reply) => {
    expect(checkClaims(reply, [], CUSTOMER_CLAIMS).ok).toBe(true);
  });
});
