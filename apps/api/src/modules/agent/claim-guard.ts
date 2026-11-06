import type { ToolResult } from '@vca/ai';

export interface CheckedStep {
  tool: string;
  result: ToolResult;
}

export interface ClaimRule {
  /** Short name for logs and audit. */
  claim: string;
  pattern: RegExp;
  /** A successful call to one of these this turn backs the claim. */
  tools: string[];
}

/** Questions, offers and plans are not claims: "Should I update the draft?" states nothing. */
const NOT_A_CLAIM =
  /\?\s*$|\b(would you like|do you want|want me to|should i|shall i|can i|could i|i can|i could|i'?ll|i will|i'm going to|let me|please|if you|once you|after you|you can|cannot|can't|couldn't|could not|haven'?t|have not|didn'?t|did not|won'?t|not been|unable|never)\b/i;

/** First person or passive past tense: "I updated", "I've added", "has been changed", "Updated". */
const done = (verbs: string) =>
  `(?:\\bi(?:'ve| have)?\\s+(?:also\\s+|just\\s+|now\\s+)?(?:${verbs})\\b|\\b(?:has|have|was|were|is|are)\\s+(?:now\\s+|also\\s+)?(?:been\\s+)?(?:${verbs})\\b|^\\W*(?:${verbs})\\b)`;

const ORDER_WRITE = ['create_draft_order', 'update_draft_order', 'request_payment'];
const ORDER_FACTS = ['get_order', 'find_orders', 'list_payments', 'get_payment_status'];
const CUSTOMER_MESSAGE = ['reply_to_customer', 'remind_customer'];

export const MERCHANT_CLAIMS: ClaimRule[] = [
  {
    claim: 'order_changed',
    pattern: new RegExp(
      `${done('updated|changed|added|removed|edited|applied|included|set')}.*\\b(draft|order|shipping|delivery|quantity|quantities|discount|total)\\b|\\b(draft|order|shipping|quantity|total)\\b.*${done('updated|changed|added|removed|edited|applied|included|set')}`,
      'i',
    ),
    tools: ORDER_WRITE,
  },
  {
    claim: 'product_changed',
    pattern: new RegExp(
      `${done('updated|changed|lowered|raised|reduced|increased|set|deactivated')}.*\\b(price|product|reorder)\\b|\\b(price|product)\\b.*${done('updated|changed|lowered|raised|reduced|increased|set|deactivated')}`,
      'i',
    ),
    tools: ['update_product', 'add_product'],
  },
  {
    claim: 'stock_changed',
    pattern: new RegExp(
      `${done('added|recorded|updated|adjusted|removed|restocked|reordered|ordered')}.*\\b(stock|inventory|units|supplier)\\b`,
      'i',
    ),
    tools: ['adjust_stock', 'add_product'],
  },
  {
    claim: 'customer_messaged',
    pattern: new RegExp(`${done('sent|told|messaged|informed|notified|replied|forwarded')}`, 'i'),
    tools: [...CUSTOMER_MESSAGE, ...ORDER_FACTS],
  },
  {
    claim: 'payment_created',
    pattern: /\bpayment (request|link)\b.*\b(created|sent|generated|issued)\b/i,
    tools: ORDER_FACTS,
  },
  {
    claim: 'order_cancelled',
    pattern: new RegExp(`${done('cancelled|canceled|refunded|discarded|deleted')}`, 'i'),
    tools: [...ORDER_FACTS, 'cancel_order'],
  },
  {
    claim: 'tracking_updated',
    pattern: /\btracking\b.*\b(updated|added|sent)\b/i,
    tools: ['get_shipping_status', 'list_shipments'],
  },
  {
    claim: 'chat_resumed',
    pattern: new RegExp(`${done('resumed|switched|turned')}`, 'i'),
    tools: ['resume_customer_chat'],
  },
];

export const CUSTOMER_CLAIMS: ClaimRule[] = [
  {
    claim: 'address_set',
    pattern:
      /\b(address|delivery details?)\b.*\b(set|updated|changed|saved|noted|recorded)\b|\b(set|updated|changed|saved|noted)\b.*\baddress\b/i,
    tools: ['change_delivery'],
  },
  {
    claim: 'order_placed',
    pattern:
      /\b(order|purchase)\b.*\b(has been |is |was )(placed|confirmed|completed|received)\b|\byour order is (placed|confirmed)\b/i,
    tools: ['my_orders'],
  },
  {
    claim: 'payment_received',
    pattern:
      /\bpayment\b.*\b(received|confirmed|went through|successful)\b|\byou('ve| have) paid\b/i,
    tools: ['my_orders'],
  },
  {
    claim: 'shipped',
    pattern: /\b(has|have|was|were) (been )?(shipped|delivered|dispatched)\b/i,
    tools: ['my_orders'],
  },
  {
    claim: 'cart_changed',
    pattern: new RegExp(`${done('added|removed|updated|changed')}.*\\b(cart|basket)\\b`, 'i'),
    tools: ['add_to_cart', 'update_cart', 'accept_offer', 'negotiate_price', 'decline_offer'],
  },
];

/** Approval words with a code must come from the backend, never from the model. */
const APPROVAL_CODE = /\b(CONFIRM|SHIP|SUBMIT|REMIND|CANCEL(?: ORDER)?)\b[\s*_]*\d{4}\b/i;
/** A draft or order summary with a total reads as the backend's; only tools may back it. */
const SUMMARY_SHAPE = /\b(draft order|order summary)\b[\s\S]*\btotal\b/i;
const SUMMARY_TOOLS = [...ORDER_WRITE, ...ORDER_FACTS, 'calculate_order_total'];

export type ClaimCheck = { ok: true } | { ok: false; claim: string };

const succeeded = (steps: CheckedStep[], tools: string[]) =>
  steps.some((s) => s.result.ok && tools.includes(s.tool));

const sentencesOf = (reply: string) =>
  reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Compares what a model wrote with what its tools did this turn. Prompt rules ask the model not to
 * claim actions it didn't take; this makes that a guarantee for the claims that matter.
 */
export function checkClaims(reply: string, steps: CheckedStep[], rules: ClaimRule[]): ClaimCheck {
  if (APPROVAL_CODE.test(reply)) return { ok: false, claim: 'approval_code' };
  if (SUMMARY_SHAPE.test(reply) && !succeeded(steps, SUMMARY_TOOLS))
    return { ok: false, claim: 'order_summary' };
  for (const sentence of sentencesOf(reply)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
    for (const rule of rules)
      if (rule.pattern.test(sentence) && !succeeded(steps, rule.tools))
        return { ok: false, claim: rule.claim };
  }
  return { ok: true };
}
