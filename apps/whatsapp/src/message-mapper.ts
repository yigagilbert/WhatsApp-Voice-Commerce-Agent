import type { InboundChannelMessage, UnsupportedKind } from '@vca/shared';

/**
 * The subset of a whatsapp-web.js Message we depend on. Declared structurally so the
 * mapping logic is unit-testable without a browser session.
 */
/**
 * WhatsApp message ID as delivered by whatsapp-web.js. The library's types promise `_serialized`,
 * but current WhatsApp Web builds can omit it at runtime, so every field is treated as optional.
 */
export interface WhatsAppMessageIdLike {
  _serialized?: unknown;
  /** WhatsApp Web (July 2026+) exposes the serialized id under this name instead. */
  $1?: unknown;
  fromMe?: unknown;
  remote?: unknown;
  id?: unknown;
}

const widToString = (wid: unknown): string | undefined => {
  if (typeof wid === 'string' && wid) return wid;
  if (wid && typeof wid === 'object') {
    const w = wid as { _serialized?: unknown; user?: unknown; server?: unknown };
    if (typeof w._serialized === 'string' && w._serialized) return w._serialized;
    if (typeof w.user === 'string' && typeof w.server === 'string') return `${w.user}@${w.server}`;
  }
  return undefined;
};

/**
 * Stable message ID used for de-duplication: `_serialized` when present, otherwise rebuilt in
 * WhatsApp's own `<fromMe>_<remote>_<id>` format. Returns null if the ID can't be determined.
 */
export function serializeMessageId(id: WhatsAppMessageIdLike | undefined | null): string | null {
  if (!id) return null;
  if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
  if (typeof id.$1 === 'string' && id.$1) return id.$1;
  const remote = widToString(id.remote);
  if (typeof id.id === 'string' && id.id && remote)
    return `${id.fromMe === true ? 'true' : 'false'}_${remote}_${id.id}`;
  return null;
}

export interface WhatsAppMessageLike {
  id: WhatsAppMessageIdLike;
  from: string;
  fromMe: boolean;
  isStatus: boolean;
  broadcast?: boolean;
  type: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  /** Voice-note length in seconds as reported by WhatsApp (string or number), if any. */
  duration?: string | number | undefined;
  /** Present on wwebjs messages; push name of the sender. */
  _data?: { notifyName?: string };
}

export type SkipReason =
  'from_me' | 'status' | 'group' | 'broadcast' | 'unsupported_type' | 'empty' | 'no_id';

export type MappedMessage =
  | { kind: 'text'; message: InboundChannelMessage }
  /** User-sent content the core can't handle yet; forwarded so the core can reply politely. */
  | { kind: 'unsupported'; message: InboundChannelMessage }
  | { kind: 'audio'; base: Omit<InboundChannelMessage, 'media'> }
  | { kind: 'skip'; reason: SkipReason };

/** WhatsApp voice notes are type "ptt" (push-to-talk); forwarded audio files are "audio". */
const AUDIO_TYPES = new Set(['ptt', 'audio']);

/**
 * User-visible message types we don't process yet. Anything not listed here or above
 * (revoked, e2e_notification, call_log, protocol, ciphertext, ...) is a system event and skipped.
 */
const UNSUPPORTED_TYPES: Record<string, UnsupportedKind> = {
  image: 'image',
  video: 'video',
  gif: 'video',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  vcard: 'contact',
  multi_vcard: 'contact',
  poll_creation: 'other',
};

/**
 * Converts a WhatsApp message into the channel-agnostic inbound contract — or explains
 * why it is skipped. Only 1:1 chats are handled; groups, statuses and our own messages are ignored.
 */
export function mapWhatsAppMessage(
  msg: WhatsAppMessageLike,
  options: { voiceNotesEnabled?: boolean } = {},
): MappedMessage {
  if (msg.fromMe) return { kind: 'skip', reason: 'from_me' };
  if (msg.isStatus || msg.from === 'status@broadcast') return { kind: 'skip', reason: 'status' };
  if (msg.from.endsWith('@g.us')) return { kind: 'skip', reason: 'group' };
  // Broadcast lists and WhatsApp Channels (…@newsletter) are one-to-many, never merchant chats.
  if (msg.broadcast || msg.from.endsWith('@broadcast') || msg.from.endsWith('@newsletter'))
    return { kind: 'skip', reason: 'broadcast' };

  const externalMessageId = serializeMessageId(msg.id);
  if (!externalMessageId) return { kind: 'skip', reason: 'no_id' };

  const base = {
    channel: 'whatsapp' as const,
    externalMessageId,
    externalChatId: msg.from,
    senderId: msg.from,
    ...(msg._data?.notifyName ? { senderName: msg._data.notifyName } : {}),
    sentAt: new Date(msg.timestamp * 1000),
  };

  if (msg.type === 'chat') {
    const text = msg.body.trim();
    if (!text) return { kind: 'skip', reason: 'empty' };
    return { kind: 'text', message: { ...base, type: 'text', text: text.slice(0, 4096) } };
  }
  if (AUDIO_TYPES.has(msg.type) && msg.hasMedia) {
    // Voice disabled: don't download anything; the core replies "coming soon".
    if (!options.voiceNotesEnabled) {
      return {
        kind: 'unsupported',
        message: { ...base, type: 'unsupported', unsupportedKind: 'voice' },
      };
    }
    return { kind: 'audio', base: { ...base, type: 'audio' } };
  }
  const unsupportedKind = UNSUPPORTED_TYPES[msg.type];
  if (unsupportedKind) {
    return { kind: 'unsupported', message: { ...base, type: 'unsupported', unsupportedKind } };
  }
  return { kind: 'skip', reason: 'unsupported_type' };
}

/** WhatsApp's own duration for a voice note, when it is a sane number. */
export function durationHintSeconds(
  msg: Pick<WhatsAppMessageLike, 'duration'>,
): number | undefined {
  const n = typeof msg.duration === 'string' ? Number(msg.duration) : msg.duration;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}
