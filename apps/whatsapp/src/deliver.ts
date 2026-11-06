import type { OutgoingImage } from './whatsapp-adapter';

export interface ReplyToSend {
  externalChatId: string;
  text: string;
  media?: OutgoingImage;
  /** Our record of this reply, so its WhatsApp ID can be reported back. */
  messageId?: string | undefined;
}

interface ReplyTransport {
  sendText(chatId: string, text: string): Promise<string | null | void>;
  sendImage(chatId: string, image: OutgoingImage, caption: string): Promise<string | null | void>;
}

export interface Delivery {
  messageId: string;
  stanzaId: string;
}

/**
 * Sends the API's replies in order. A photo is never essential: when WhatsApp Web refuses an
 * image (it has, in production, inline and as a document), its caption goes as text and the
 * remaining replies still go out, so the customer sees the product details instead of an error.
 * Text failures still throw: without text there is nothing useful left to send.
 */
export async function deliverReplies(
  transport: ReplyTransport,
  replies: ReplyToSend[],
  logger: { warn(details: object, message: string): void },
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  const note = (reply: ReplyToSend, stanzaId: string | null | void) => {
    if (reply.messageId && stanzaId) deliveries.push({ messageId: reply.messageId, stanzaId });
  };
  for (const reply of replies) {
    if (!reply.media) {
      note(reply, await transport.sendText(reply.externalChatId, reply.text));
      continue;
    }
    try {
      note(reply, await transport.sendImage(reply.externalChatId, reply.media, reply.text));
    } catch (error) {
      logger.warn({ err: error }, 'image reply could not be sent; sending its text instead');
      if (reply.text.trim())
        note(reply, await transport.sendText(reply.externalChatId, reply.text));
    }
  }
  return deliveries;
}
