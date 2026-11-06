import { z } from 'zod';

/**
 * Channel contracts. A channel adapter (WhatsApp today; web chat, Telegram, mobile later)
 * converts its native events into an `InboundChannelMessage` and delivers `OutboundChannelMessage`s.
 * Nothing in the core depends on a specific channel SDK.
 */
export const CHANNELS = ['whatsapp', 'web', 'api', 'telegram'] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

export const inboundMediaSchema = z.object({
  mimeType: z.string().min(1).max(100),
  /** Base64 payload. Voice notes are small; size is capped by MEDIA_MAX_BYTES on both sides. */
  dataBase64: z.string().min(1),
  filename: z.string().max(255).optional(),
  durationSeconds: z.number().nonnegative().optional(),
});
export type InboundMedia = z.infer<typeof inboundMediaSchema>;

export const UNSUPPORTED_KINDS = [
  /** Voice note received while the voice pipeline is disabled (not downloaded). */
  'voice',
  'image',
  'video',
  'document',
  'sticker',
  'location',
  'contact',
  'other',
] as const;
export type UnsupportedKind = (typeof UNSUPPORTED_KINDS)[number];

export const inboundChannelMessageSchema = z
  .object({
    channel: channelSchema,
    /** Provider message ID — used for de-duplication. */
    externalMessageId: z.string().min(1).max(255),
    /** The chat/thread the message belongs to (where replies go). */
    externalChatId: z.string().min(1).max(255),
    /** Identity of the sender within the channel (e.g. WhatsApp ID). Used for authorization. */
    senderId: z.string().min(1).max(255),
    /** Sender phone (E.164) when the channel adapter could resolve it (WhatsApp linked IDs). */
    senderPhone: z
      .string()
      .regex(/^\+\d{6,15}$/)
      .optional(),
    /** Display name from the sender's profile (user-controlled: display only, never trusted). */
    senderName: z.string().max(255).optional(),
    /**
     * The bot account that received the message (WhatsApp: the linked number's ID). Decides which
     * merchant a customer is talking to.
     */
    recipientId: z.string().min(1).max(255).optional(),
    sentAt: z.coerce.date(),
    /**
     * `unsupported`: a real user message the core can't handle yet (image, document, ...).
     * Forwarded (without media) so the core — not the channel — decides how to respond.
     */
    type: z.enum(['text', 'audio', 'unsupported']),
    text: z.string().max(4096).optional(),
    media: inboundMediaSchema.optional(),
    unsupportedKind: z.enum(UNSUPPORTED_KINDS).optional(),
    /**
     * The message this one replies to. `stanzaId` is matched against our own records; `text` comes
     * from the sender's device, can be forged, and is only ever treated as customer content.
     */
    quoted: z
      .object({
        stanzaId: z.string().min(1).max(128).optional(),
        text: z.string().max(1000).optional(),
      })
      .optional(),
    /** A shared location pin (unsupportedKind "location"). */
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        description: z.string().max(300).optional(),
      })
      .optional(),
  })
  .refine(
    (m) =>
      m.type === 'text' ? !!m.text?.trim() : m.type === 'audio' ? !!m.media : !!m.unsupportedKind,
    { message: 'text needs `text`; audio needs `media`; unsupported needs `unsupportedKind`' },
  );
export type InboundChannelMessage = z.infer<typeof inboundChannelMessageSchema>;

/** Images Katale sends (charts). Text becomes the image caption. ~1.5 MB of base64 at most. */
export const outboundMediaSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  dataBase64: z.string().min(1).max(2_000_000),
  filename: z.string().min(1).max(120).optional(),
});
export type OutboundMedia = z.infer<typeof outboundMediaSchema>;

export const outboundChannelMessageSchema = z.object({
  channel: channelSchema,
  externalChatId: z.string().min(1).max(255),
  text: z.string().min(1).max(4096),
  media: outboundMediaSchema.optional(),
  /** Our Message row, so the worker can report WhatsApp's ID for it after sending. */
  messageId: z.string().min(1).max(64).optional(),
});
export type OutboundChannelMessage = z.infer<typeof outboundChannelMessageSchema>;

/** WhatsApp's Status ("stories") chat. Customer sends must never target it. */
export const isStatusChatId = (chatId: string) => /@\w*broadcast\b/.test(chatId);

/** A Status advert the WhatsApp worker posts to the shop's own Status. */
export const statusPostSchema = z.object({
  /** The shop's own bot numbers: the worker posts only while one of them is connected. */
  botIds: z.array(z.string().min(1).max(255)).min(1).max(20),
  media: outboundMediaSchema,
  caption: z.string().max(700),
});
export type StatusPost = z.infer<typeof statusPostSchema>;

/** Response returned to a channel adapter after the core processed an inbound message. */
export interface InboundProcessingResult {
  status: 'processed' | 'duplicate' | 'ignored';
  replies: OutboundChannelMessage[];
}

/** Implemented by anything that can deliver messages on a channel. */
export interface ChannelSender {
  readonly channel: Channel;
  /** May return the channel's short ID for the sent message, used to resolve quoted replies. */
  send(message: OutboundChannelMessage): Promise<{ stanzaId?: string | null } | void>;
}

/** Reported by a channel worker after sending: which of our messages got which channel ID. */
export const deliveryReportSchema = z.object({
  deliveries: z
    .array(z.object({ messageId: z.string().min(1).max(64), stanzaId: z.string().min(1).max(128) }))
    .min(1)
    .max(20),
});
