import { currencyExponent } from '@vca/commerce';

/** "$28", "$ 28", "$1,200.50", "USD 28", "UGX 50,000", "28 dollars", "50,000/=". */
const PREFIXED =
  /(?:US\$|\$|€|£|\b(?:USD|UGX|USh|UShs|KES|KSh|TZS|EUR|GBP|Shs?\.?))\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;
const SUFFIXED =
  /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|UGX|USh|UShs|KES|KSh|TZS|EUR|GBP|dollars?|bucks|shillings?|shs?\b|\/=)/gi;
/** "50k", as prices are often written here. */
const THOUSANDS = /\b(\d{1,4})k\b/gi;
/** A price in another currency than the shop's is never a price the shop gave. */
const CURRENCY_MARKS: [RegExp, string[]][] = [
  [/(?:US\$|\$|\bUSD\b|\bdollars?\b)\s?\d|\d\s?(?:USD|dollars?)\b/i, ['USD']],
  [/€\s?\d|\bEUR\s?\d|\d\s?(?:EUR|euros?)\b/i, ['EUR']],
  [/£\s?\d|\bGBP\s?\d|\d\s?(?:GBP|pounds?)\b/i, ['GBP']],
  [/\b(?:UGX|USh|UShs)\s?\d|\d\s?(?:UGX|USh|UShs)\b/i, ['UGX']],
  [/\b(?:KES|KSh)\s?\d|\d\s?(?:KES|KSh)\b/i, ['KES']],
  [/\bTZS\s?\d|\d\s?TZS\b/i, ['TZS']],
];
const WORD_NUMBER =
  '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)';
/** "fifty thousand shillings": an amount in words can't be checked, so the model mustn't write it. */
const AMOUNT_IN_WORDS = new RegExp(
  `\\b${WORD_NUMBER}(?:[ -]${WORD_NUMBER})*\\s(?:dollars?|bucks|shillings?|shs?|euros?|pounds?)\\b`,
  'i',
);
const PERCENT =
  /\b(\d{1,3})\s?(?:%|percent|per cent)|\b(?:one|two|three|four|five|ten|fifteen|twenty|thirty|forty|fifty)\s?(?:percent|per cent)\b/gi;
const FREE_OFFER = /\bfree\s+(?:delivery|shipping|gift|item|of charge)\b|\bfor free\b/i;

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
  for (const match of text.matchAll(THOUSANDS))
    amounts.add(Number(match[1]) * 1000 * 10 ** exponent);
  return [...amounts];
}

/**
 * Promises that aren't amounts: percentages, "free delivery", a price in another currency or in
 * words. `backendText` is what tools and the shop's earlier messages said, which may back them.
 */
export function unbackedPromises(reply: string, currency: string, backendText = ''): string[] {
  const found: string[] = [];
  for (const [pattern, codes] of CURRENCY_MARKS)
    if (pattern.test(reply) && !codes.includes(currency)) found.push('foreign_currency');
  if (AMOUNT_IN_WORDS.test(reply)) found.push('amount_in_words');
  const backed = new Set([...backendText.matchAll(PERCENT)].map((m) => m[0].toLowerCase()));
  for (const match of reply.matchAll(PERCENT))
    if (!backed.has(match[0].toLowerCase())) found.push('percent');
  if (FREE_OFFER.test(reply) && !FREE_OFFER.test(backendText)) found.push('free');
  return found;
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
  backendText?: string;
}): { ok: true } | { ok: false; unexpected: number[]; missing: number | null; promises: string[] } {
  const allowed = new Set(input.allowedMinor);
  const stated = moneyAmounts(input.reply, input.currency);
  const unexpected = stated.filter((a) => !allowed.has(a));
  const missing =
    input.requiredMinor !== null && !stated.includes(input.requiredMinor)
      ? input.requiredMinor
      : null;
  const promises = unbackedPromises(input.reply, input.currency, input.backendText);
  return unexpected.length || missing !== null || promises.length
    ? { ok: false, unexpected, missing, promises }
    : { ok: true };
}
