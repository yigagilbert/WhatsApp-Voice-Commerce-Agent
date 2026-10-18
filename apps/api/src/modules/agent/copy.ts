import type { ConfirmationAction } from '@vca/database';
import type { UnsupportedKind } from '@vca/shared';

/**
 * User-facing Katale AI copy for system-generated (non-LLM) replies. Formatted for WhatsApp
 * (*bold*, _italic_), which the web console also renders.
 */
export const BRAND = 'Katale AI';

/**
 * The word that approves each action: CONFIRM (payments), SHIP (tracking), SUBMIT (disputes),
 * REMIND (payment reminders).
 */
export const approvalWord = (action: ConfirmationAction | undefined) =>
  action === 'ADD_SHIPMENT_TRACKING'
    ? 'SHIP'
    : action === 'SUBMIT_DISPUTE_RESPONSE'
      ? 'SUBMIT'
      : action === 'SEND_PAYMENT_REMINDER'
        ? 'REMIND'
        : 'CONFIRM';

/** Prefixes a system message with the Katale AI header. */
export const branded = (body: string): string => `*${BRAND}*\n\n${body}`;

const UNSUPPORTED_LABEL: Record<Exclude<UnsupportedKind, 'voice'>, string> = {
  image: 'images',
  video: 'videos',
  document: 'documents',
  sticker: 'stickers',
  location: 'locations',
  contact: 'contact cards',
  other: 'that type of message',
};

export const copy = {
  /**
   * The only reply a number that isn't an active admin ever gets: no business details, no IDs,
   * and no hint about whether the number is a customer, a former admin or a stranger.
   */
  welcome:
    "Hello! 👋 Welcome to Katale AI. Our team will get back to you as soon as they're available.",
  ownerOnly: branded(
    '🔒 Only an owner can approve payment requests and dispute responses. Nothing was sent. Ask an owner to do it from their WhatsApp.',
  ),
  voiceComingSoon: branded(
    'Voice messages are coming soon. Please send your request as text for now.',
  ),
  unsupported: (kind: UnsupportedKind) =>
    kind === 'voice'
      ? branded('Voice messages are coming soon. Please send your request as text for now.')
      : branded(`I can't read ${UNSUPPORTED_LABEL[kind]} yet. Please send your request as text.`),
  voiceDownloadFailed: "I couldn't access that voice note. Please try sending it again.",
  voiceInvalid:
    "I couldn't process that audio. Please send a WhatsApp voice note or type your request.",
  voiceUnavailable:
    "I couldn't understand that voice note. Please try again or send the request as text.",
  voiceTooLong: (maxSeconds: number) =>
    `That voice note is too long for now. Please keep it under ${maxSeconds} seconds or send the request as text.`,
  voiceUnclear: (transcript: string) =>
    branded(
      [
        'I heard:',
        '',
        `"${transcript}"`,
        '',
        'Is that right? Reply *YES* to continue, or send your request again.',
      ].join('\n'),
    ),
  voiceUnclearDismissed: 'OK — please send your request again, or type it.',
  voiceConfirmationMustBeTyped: (word: string, code: string | undefined) =>
    `For your security, payment requests are approved by text only. Please type *${word}${code ? ` ${code}` : ' <code>'}* to continue.`,
  emptyMessage: "I couldn't make out any words in that message. Could you try again?",
  assistantUnavailable: 'Katale AI is temporarily unavailable. Please try again shortly.',
  aiNotConfigured:
    "Katale AI's assistant isn't set up yet. Confirmation replies (CONFIRM / CANCEL) still work.",

  // Confirmation replies (deterministic; never written by the LLM).
  nothingToConfirm: 'There is nothing waiting for your confirmation right now.',
  nothingToCancel: 'OK, there was nothing pending to cancel.',
  confirmationExpired:
    '⌛ That request expired before it was confirmed, so nothing was sent. Ask me again to create a fresh one.',
  codeMismatch: (word: string, code: string) =>
    `That code doesn't match the pending request. Reply *${word} ${code}* or *CANCEL*.`,
  wrongVerb: (word: string, code: string) =>
    `To approve this, reply *${word} ${code}* (or *CANCEL*). Nothing has been changed.`,
  draftDiscarded: (reference: string | null) =>
    reference
      ? `👍 Discarded. Draft ${reference} was cancelled and nothing was sent.`
      : '👍 Cancelled. Nothing was sent.',
  integrityFailed: '❌ That request could not be verified and was discarded. Please start again.',
  alreadyConfirmed: (lines: string[]) =>
    ['That payment request was already created, so nothing new was sent.', '', ...lines].join('\n'),
  stillProcessing: "I'm still working on that confirmation. I'll reply as soon as it's done.",
  paymentRequestFailed: (reference: string) =>
    branded(
      [
        "❌ I couldn't create the payment request right now. Your order has not been charged.",
        '',
        `Order ${reference} is still saved as a draft. Ask me to "request payment for ${reference}" to try again.`,
      ].join('\n'),
    ),
  actionFailed: (reason: string) => branded(`❌ I couldn't complete that: ${reason}`),
  unexpectedError: branded(
    '❌ Something went wrong on our side and nothing was sent. Please try again.',
  ),

  // Shipments
  shipmentUpdated: (lines: string[]) =>
    branded(
      [
        '📦 *Shipment updated*',
        '',
        ...lines,
        'Status: Shipped',
        '',
        'Tracking has been updated with PayPal.',
      ].join('\n'),
    ),
  shipmentFailed: (reference: string) =>
    branded(
      [
        `❌ I couldn't update tracking for ${reference}.`,
        '',
        'The order is unchanged. Please check the carrier and tracking number and try again.',
      ].join('\n'),
    ),

  // Disputes
  disputeSubmitted: (lines: string[], evidence: string[]) =>
    branded(
      [
        '✅ *Dispute response submitted*',
        '',
        ...lines,
        '',
        'Evidence sent:',
        ...evidence.map((e) => `- ${e}`),
        '',
        "I'll keep monitoring the dispute status.",
      ].join('\n'),
    ),
  disputeSubmitFailed: (disputeId: string, reason: string) =>
    branded(
      `❌ I couldn't submit the response for dispute ${disputeId}: ${reason}\n\nNothing was sent to PayPal.`,
    ),
};
