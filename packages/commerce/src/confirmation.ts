import { createHash, randomInt } from 'node:crypto';
import type { ConfirmationAction } from '@vca/database';

/**
 * Financial-safety policy: which actions must be explicitly confirmed by the merchant.
 * The agent can only *propose* these; execution happens exclusively through
 * a matching, unexpired ActionConfirmation.
 */
export const ACTIONS_REQUIRING_CONFIRMATION: ReadonlySet<ConfirmationAction> = new Set([
  'CREATE_PAYMENT_REQUEST',
  'ADD_SHIPMENT_TRACKING',
  'SUBMIT_DISPUTE_RESPONSE',
  'SEND_INVOICE',
  'REFUND_PAYMENT',
]);

export const requiresConfirmation = (action: ConfirmationAction): boolean =>
  ACTIONS_REQUIRING_CONFIRMATION.has(action);

/**
 * Deterministic confirmation vocabulary. Non-English entries are a starting point and
 * must be validated with native speakers before production use.
 */
const CONFIRM_PHRASES = [
  // English
  'yes',
  'y',
  'yeah',
  'yep',
  'confirm',
  'confirmed',
  'ok',
  'okay',
  'go ahead',
  'proceed',
  'approve',
  'approved',
  'send it',
  'do it',
  // Luganda (to validate)
  'yee',
  'kakasa',
  // Swahili (to validate)
  'ndiyo',
  'thibitisha',
];

const CANCEL_PHRASES = [
  'no',
  'n',
  'nope',
  'cancel',
  'stop',
  'abort',
  'reject',
  // Luganda (to validate)
  'nedda',
  'sazaamu',
  // Swahili (to validate)
  'hapana',
  'ghairi',
];

/**
 * `verb` names the action a reply approves: CONFIRM (payment requests, and bare yes/ok),
 * SHIP (shipment tracking) or SUBMIT (dispute responses). SHIP and SUBMIT always need the code.
 */
export type ConfirmationVerb = 'confirm' | 'ship' | 'submit';
export type ConfirmationReply = {
  kind: 'confirm' | 'cancel';
  code?: string;
  verb?: ConfirmationVerb;
};

/** The verb each confirmable action must be approved with; strict actions also need the code. */
export const ACTION_VERBS: Record<
  ConfirmationAction,
  { verb: ConfirmationVerb; codeRequired: boolean }
> = {
  CREATE_PAYMENT_REQUEST: { verb: 'confirm', codeRequired: false },
  ADD_SHIPMENT_TRACKING: { verb: 'ship', codeRequired: true },
  SUBMIT_DISPUTE_RESPONSE: { verb: 'submit', codeRequired: true },
  SEND_INVOICE: { verb: 'confirm', codeRequired: true },
  REFUND_PAYMENT: { verb: 'confirm', codeRequired: true },
};

const VERB_PATTERN = /^(?<verb>ship|submit)\s+(?<code>\d{4})$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseGroup = (phrases: string[]) =>
  phrases
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
const REPLY_PATTERN = new RegExp(
  `^(?:(?<confirm>${phraseGroup(CONFIRM_PHRASES)})|(?<cancel>${phraseGroup(CANCEL_PHRASES)}))(?:\\s+(?<code>\\d{4}))?$`,
);

/**
 * Recognises short, unambiguous confirm/cancel replies ("yes", "confirm 4821", "cancel").
 * Anything longer ("yes but make it 40 baskets") returns null and goes to the agent instead.
 */
export function parseConfirmationReply(text: string): ConfirmationReply | null {
  const normalized = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const verbMatch = VERB_PATTERN.exec(normalized);
  if (verbMatch?.groups) {
    return {
      kind: 'confirm',
      code: verbMatch.groups.code!,
      verb: verbMatch.groups.verb as ConfirmationVerb,
    };
  }
  const match = REPLY_PATTERN.exec(normalized);
  if (!match?.groups) return null;
  const code = match.groups.code;
  const kind = match.groups.confirm ? 'confirm' : 'cancel';
  const verb = kind === 'confirm' ? ({ verb: 'confirm' } as const) : {};
  return code ? { kind, code, ...verb } : { kind, ...verb };
}

/** Stable JSON serialisation (sorted keys) so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const hashPayload = (payload: unknown): string =>
  createHash('sha256').update(canonicalJson(payload)).digest('hex');

/** 4-digit code the merchant can quote to disambiguate. */
export const generateConfirmationCode = (): string => String(randomInt(1000, 10000));
