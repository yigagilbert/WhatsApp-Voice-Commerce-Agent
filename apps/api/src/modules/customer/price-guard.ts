import { currencyExponent } from '@vca/commerce';

/** "$28", "$ 28", "$1,200.50", "USD 28", "UGX 50,000", "28 dollars", "50,000/=". */
const PREFIXED =
  /(?:US\$|\$|€|£|\b(?:USD|UGX|KES|TZS|EUR|GBP|Shs?\.?))\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;
const SUFFIXED =
  /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|UGX|KES|TZS|EUR|GBP|dollars?|bucks|shillings?|\/=)/gi;

/**
 * Money amounts written in a reply, as minor units of `currency`. Used to check that every price
 * the assistant states was produced by the backend in this conversation.
 */
export function moneyAmounts(text: string, currency: string): number[] {
  const exponent = currencyExponent(currency);
  const amounts = new Set<number>();
  for (const pattern of [PREFIXED, SUFFIXED])
    for (const match of text.matchAll(pattern)) {
      const whole = Number(match[1]!.replace(/,/g, ''));
      const fraction = (match[2] ?? '').padEnd(exponent, '0').slice(0, exponent);
      amounts.add(whole * 10 ** exponent + (exponent ? Number(fraction || '0') : 0));
    }
  return [...amounts];
}

/**
 * Checks an AI reply against the amounts the backend produced. A reply fails if it states any
 * amount the backend didn't (an invented discount, a price "agreed" by the model), or if a
 * bargaining step happened and the reply leaves out the shop's actual offer.
 */
export function checkReplyPrices(input: {
  reply: string;
  currency: string;
  allowedMinor: Iterable<number>;
  requiredMinor: number | null;
}): { ok: true } | { ok: false; unexpected: number[]; missing: number | null } {
  const allowed = new Set(input.allowedMinor);
  const stated = moneyAmounts(input.reply, input.currency);
  const unexpected = stated.filter((a) => !allowed.has(a));
  const missing =
    input.requiredMinor !== null && !stated.includes(input.requiredMinor)
      ? input.requiredMinor
      : null;
  return unexpected.length || missing !== null ? { ok: false, unexpected, missing } : { ok: true };
}
