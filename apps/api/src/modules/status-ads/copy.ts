import type { ChatModel } from '@vca/ai';

/**
 * Wording for WhatsApp Status adverts. Prices never come from here: the image prints the catalogue
 * price at render time. AI copy is optional and must pass `copyProblem`; otherwise the templates
 * below are used, so an advert never carries an invented discount, price, offer or claim.
 */

export const HEADLINE_MAX = 48;
export const CAPTION_MAX = 280;

/** Calls to action: fixed wording, nothing the shop can't honour. */
export const CTAS = [
  'Message us to order',
  'Reply to this status to order',
  'Chat with us to see more',
  'Browse our shop on WhatsApp',
  'Order on WhatsApp today',
] as const;
export type Cta = (typeof CTAS)[number];

const HEADLINES = [
  'Today’s pick',
  'In stock now',
  'Have you seen this?',
  'Fresh in the shop',
  'Made for your day',
  'Take a closer look',
  'Ready when you are',
  'Spotted something you like?',
  'Come and take a look',
  'Now on our shelves',
];

/**
 * Words and patterns an advert must not contain: prices, discounts and offers (the shop decides
 * those, not the agent), superlatives, health and guarantee claims.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/\d/, 'numbers (prices and quantities come from the catalogue)'],
  [/[$€£¥₦₹%]|\b(ugx|usd|kes|tzs|shs?|shillings?|dollars?)\b/i, 'prices or currency'],
  [
    /\b(discounts?|sales?|off|deals?|offers?|promos?|promotions?|coupons?|vouchers?|bargains?|save|savings|free|cheap(est|er)?|clearance|bogo|giveaway|price[sd]?|cost)\b/i,
    'discounts, offers or prices',
  ],
  [
    /\b(limited|hurry|last chance|only today|today only|while stocks? last|ends? (soon|today|tonight)|expires?)\b/i,
    'invented urgency',
  ],
  [/\b(best|#1|number one|top[- ]rated|award|guarantee[ds]?|certified|official)\b/i, 'claims'],
  [
    /\b(cures?|heals?|treats?|prevents?|medical|clinically|doctor|organic|natural|eco|vegan|handmade|imported|genuine|authentic|original)\b/i,
    'product claims',
  ],
];

/** Why a piece of AI copy can't be used (null when it can). Facts the shop wrote are allowed. */
export function copyProblem(text: string, facts: string): string | null {
  const known = facts.toLowerCase();
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text))
    return 'not in English';
  for (const [pattern, reason] of FORBIDDEN) {
    const match = text.match(pattern);
    // A word from the product's own name or description (e.g. "Organic honey") is the shop's
    // claim, not the agent's.
    if (match && !(/[a-z]/i.test(match[0]) && known.includes(match[0].toLowerCase())))
      return `mentions ${reason}`;
  }
  return null;
}

export interface ProductFacts {
  name: string;
  description: string | null;
}

export interface AdCopy {
  headline: string;
  caption: string;
  source: 'ai' | 'template';
}

const firstSentence = (text: string | null, max = 160) => {
  const sentence =
    text
      ?.trim()
      .split(/(?<=[.!?])\s+/)[0]
      ?.trim() ?? '';
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
};

/** The template caption: product name, the merchant's own description, the call to action. */
export function templateCaption(product: ProductFacts, cta: string): string {
  const description = firstSentence(product.description);
  return [product.name, description, `${cta} 💬`].filter(Boolean).join('\n');
}

/** A template headline not used recently (rotates by `seed`). */
export function templateHeadline(recent: string[], seed: number): string {
  const used = new Set(recent.map((h) => h.toLowerCase()));
  const fresh = HEADLINES.filter((h) => !used.has(h.toLowerCase()));
  const pool = fresh.length ? fresh : HEADLINES;
  return pool[Math.abs(seed) % pool.length]!;
}

/** The call to action least recently used (first in list order on ties). */
export function nextCta(recent: string[]): Cta {
  const lastUse = (cta: string) => {
    const i = recent.indexOf(cta);
    return i === -1 ? Infinity : i;
  };
  return [...CTAS].sort((a, b) => lastUse(b) - lastUse(a))[0]!;
}

/**
 * Chooses what to promote: the eligible product featured least recently, never one already
 * featured today while another is available. `lastFeatured` maps product ID → last advert time.
 */
export function pickProduct<T extends { id: string; name: string }>(
  eligible: T[],
  lastFeatured: Map<string, Date>,
  todayStart: Date,
): T | null {
  if (!eligible.length) return null;
  const at = (p: T) => lastFeatured.get(p.id)?.getTime() ?? -Infinity;
  const sorted = [...eligible].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name));
  const fresh = sorted.filter((p) => at(p) < todayStart.getTime());
  return (fresh[0] ?? sorted[0])!;
}

const SYSTEM_PROMPT = `You write short WhatsApp Status adverts for a small shop, in plain English.
Use only the product name and description you are given. Do not mention prices, numbers,
discounts, sales, offers, deals, free items, deadlines or urgency. Do not claim the product is the
best, guaranteed, organic, handmade, healthy or anything else the description does not say.
No hashtags. At most one emoji.
Reply with JSON only: {"headline": "...", "caption": "..."}
- headline: at most 6 words, an inviting hook (not the product name).
- caption: one or two sentences (at most 200 characters) describing the product from its
  description, ending with this call to action exactly: "{CTA}".`;

/**
 * Asks the model for a headline and caption, and returns them only if they pass the guard.
 * Returns null (use the templates) on any failure: no model, bad JSON, or rejected wording.
 */
export async function aiCopy(
  model: ChatModel | null,
  product: ProductFacts,
  cta: string,
  recentHeadlines: string[],
): Promise<{ copy: AdCopy | null; rejected?: string }> {
  if (!model) return { copy: null };
  const facts = `${product.name}\n${product.description ?? ''}`;
  const response = await model.complete({
    temperature: 0.8,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT.replace('{CTA}', cta) },
      {
        role: 'user',
        content: JSON.stringify({
          product: product.name,
          description: product.description ?? '',
          avoid_headlines: recentHeadlines.slice(0, 10),
        }),
      },
    ],
  });
  const raw = response.message.content ?? '';
  let parsed: { headline?: unknown; caption?: unknown };
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as typeof parsed;
  } catch {
    return { copy: null, rejected: 'not JSON' };
  }
  const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : '';
  let caption = typeof parsed.caption === 'string' ? parsed.caption.trim() : '';
  if (!headline || !caption) return { copy: null, rejected: 'missing fields' };
  if (headline.length > HEADLINE_MAX || caption.length > CAPTION_MAX)
    return { copy: null, rejected: 'too long' };
  if (recentHeadlines.some((h) => h.toLowerCase() === headline.toLowerCase()))
    return { copy: null, rejected: 'repeats a recent headline' };
  // The call to action is checked as fixed text, so remove it before the guard reads the rest.
  const body = caption.replace(cta, '');
  const problem = copyProblem(`${headline}\n${body}`, facts);
  if (problem) return { copy: null, rejected: problem };
  if (!caption.includes(cta)) caption = `${caption}\n${cta} 💬`;
  return { copy: { headline, caption, source: 'ai' } };
}
