import { ConfigError, loadWhatsAppConfig, resolveFromRoot, type WhatsAppConfig } from '@vca/config';
import {
  KeyedQueue,
  createLogger,
  getCorrelationId,
  newCorrelationId,
  runWithContext,
  type InboundChannelMessage,
} from '@vca/shared';
import { CoreApiClient } from './api-client';
import { RecentIds } from './dedupe';
import { deliverReplies } from './deliver';
import { createGatewayServer } from './gateway-server';
import { durationHintSeconds, mapWhatsAppMessage, type MappedMessage } from './message-mapper';
import { StageClock, withTimeout } from './stages';
import { WhatsAppWebTransport, type IncomingWhatsAppMessage } from './whatsapp-adapter';

/** Voice notes still being processed after this long get a "processing…" acknowledgement. */
const VOICE_ACK_DELAY_MS = 2500;
/** WhatsApp's typing indicator lapses after about 25 s, so it is renewed before then. */
const TYPING_REFRESH_MS = 20_000;
/** Reading a quote is a nice-to-have: it never holds up the reply for long. */
const QUOTE_LOOKUP_MS = 1500;

async function main() {
  let config: WhatsAppConfig;
  try {
    config = loadWhatsAppConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({
    name: 'whatsapp',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });
  const transport = new WhatsAppWebTransport({
    clientId: config.WHATSAPP_CLIENT_ID,
    sessionDir: resolveFromRoot(config.WHATSAPP_SESSION_DIR),
    headless: config.WHATSAPP_HEADLESS,
    chromePath: config.WHATSAPP_CHROME_PATH,
    printQr: config.WHATSAPP_PRINT_QR,
    logger,
  });
  const api = new CoreApiClient(config.WHATSAPP_API_BASE_URL, config.INTERNAL_SERVICE_TOKEN);
  const recent = new RecentIds();

  const chats = new KeyedQueue();

  async function handle(
    msg: IncomingWhatsAppMessage,
    mapped: Exclude<MappedMessage, { kind: 'skip' }>,
    clock: StageClock,
  ) {
    let message: InboundChannelMessage;
    if (mapped.kind === 'audio') {
      let media;
      try {
        media = await msg.downloadMedia();
      } catch (error) {
        logger.warn({ err: error }, 'voice note download failed');
        media = null;
      }
      clock.mark('download');
      if (!media) {
        await transport.sendText(
          msg.from,
          "I couldn't get that voice note. Please try sending it again, or type your message.",
        );
        logger.warn('voice note could not be downloaded');
        return;
      }
      // Cheap pre-checks before forwarding; the API re-validates type, size, content and duration.
      const hint = durationHintSeconds(msg);
      if (
        Math.floor((media.dataBase64.length * 3) / 4) > config.MEDIA_MAX_BYTES ||
        (hint !== undefined && hint > config.VOICE_MAX_DURATION_SECONDS)
      ) {
        await transport.sendText(
          msg.from,
          `That voice note is too long for now. Please keep it under ${config.VOICE_MAX_DURATION_SECONDS} seconds or send the request as text.`,
        );
        logger.info({ durationSeconds: hint }, 'voice note too long (worker pre-check)');
        return;
      }
      message = {
        ...mapped.base,
        media: { ...media, ...(hint !== undefined ? { durationSeconds: hint } : {}) },
      };
    } else {
      // text, or an unsupported type (forwarded without media; the API decides the reply).
      message = mapped.message;
    }

    // WhatsApp's own quote field is preferred; the library lookup can fail on current builds.
    if (msg.hasQuotedMsg && !message.quoted?.stanzaId) {
      const stanzaId = await withTimeout(msg.quotedStanzaId(), QUOTE_LOOKUP_MS).catch(() => null);
      if (stanzaId) message = { ...message, quoted: { ...message.quoted, stanzaId } };
      logger.info({ found: !!stanzaId }, 'quoted message looked up through the library');
      clock.mark('quote');
    }

    // WhatsApp often identifies people by a linked ID (@lid); resolve the phone so the API can
    // authorize admins registered by phone number.
    const senderPhone = await transport.resolvePhone(message.senderId).catch(() => null);
    if (senderPhone) message = { ...message, senderPhone };
    // Which bot number received it: decides the merchant for customer conversations.
    const recipientId = transport.botId();
    if (recipientId) message = { ...message, recipientId };
    clock.mark('identity');

    // Speech recognition takes a few seconds: acknowledge slow voice notes once, so the merchant
    // knows it arrived. Fast outcomes (errors, unknown sender) don't get the extra message.
    const ack =
      message.type === 'audio'
        ? setTimeout(() => {
            void transport
              .sendText(msg.from, '🎙️ Got your voice note, one moment…')
              .catch(() => undefined);
          }, VOICE_ACK_DELAY_MS)
        : undefined;
    let result;
    try {
      result = await api.forward(message, getCorrelationId() ?? newCorrelationId());
    } finally {
      clearTimeout(ack);
    }
    clock.mark('api');
    const deliveries = await deliverReplies(transport, result.replies, logger);
    clock.mark('send');
    void api
      .reportDelivered(deliveries)
      .catch((error: unknown) => logger.warn({ err: error }, 'delivery report failed'));
    logger.info(
      {
        type: message.type,
        status: result.status,
        replies: result.replies.length,
        quoted: !!message.quoted,
        stages: clock.stages(),
        totalMs: clock.total(),
      },
      'message processed',
    );
  }

  transport.onMessage(async (msg) => {
    const mapped = mapWhatsAppMessage(msg, { voiceNotesEnabled: config.VOICE_NOTES_ENABLED });
    if (mapped.kind === 'skip') {
      if (mapped.reason === 'no_id') {
        // Field names only — never the values (they contain phone numbers).
        logger.warn(
          { idFields: Object.keys(msg.id ?? {}) },
          'message skipped: no usable message ID',
        );
      } else {
        // Reason and type only — never the content. Groups/status are too noisy for info.
        const level = mapped.reason === 'status' || mapped.reason === 'group' ? 'debug' : 'info';
        logger[level]({ reason: mapped.reason, type: msg.type }, 'message skipped');
      }
      return;
    }
    const externalMessageId =
      mapped.kind === 'audio' ? mapped.base.externalMessageId : mapped.message.externalMessageId;
    if (!recent.add(externalMessageId)) {
      logger.debug('duplicate WhatsApp event ignored'); // expected: message + message_create
      return;
    }

    // Before anything can block: ticks and typing tell the sender we have it, even if this chat's
    // earlier message is still being answered.
    const clock = new StageClock();
    void msg.markSeen().catch(() => undefined);
    void msg.showTyping().catch(() => undefined);
    const typing = setInterval(() => {
      void msg.showTyping().catch(() => undefined);
    }, TYPING_REFRESH_MS);

    // One correlation ID per WhatsApp message, propagated to the API and back. Messages from one
    // chat are answered in order, one at a time; other chats aren't held up.
    await chats.run(msg.from, () =>
      runWithContext({ correlationId: newCorrelationId() }, async () => {
        clock.mark('queued');
        try {
          await handle(msg, mapped, clock);
        } catch (error) {
          logger.error(
            { err: error, stages: clock.stages() },
            'failed to process WhatsApp message',
          );
          await transport
            .sendText(
              msg.from,
              'Sorry, something went wrong on our side. Please try again in a moment.',
            )
            .catch(() => undefined);
        } finally {
          clearInterval(typing);
          void msg.clearTyping().catch(() => undefined);
        }
      }),
    );
  });

  // whatsapp-web.js can only see and reject calls (no call audio). Decline them and point the
  // caller to voice notes, at most once per caller every 10 minutes.
  const callReplies = new Map<string, number>();
  transport.onCall(async (call) => {
    if (!config.WHATSAPP_REJECT_CALLS || call.fromMe || call.isGroup || !call.from) return;
    await call
      .reject()
      .catch((error: unknown) => logger.warn({ err: error }, 'call reject failed'));
    const last = callReplies.get(call.from) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    callReplies.set(call.from, Date.now());
    if (callReplies.size > 1000) callReplies.delete(callReplies.keys().next().value!);
    logger.info({ video: call.isVideo }, 'incoming call declined');
    await transport
      .sendText(
        call.from,
        // Neutral on purpose: the worker doesn't know whether the caller is an admin.
        "📞 Sorry, this number can't take calls. Please send a message or a voice note instead.",
      )
      .catch(() => undefined);
  });

  const gateway = createGatewayServer({
    transport,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    logger,
  });
  gateway.listen(config.WHATSAPP_GATEWAY_PORT, config.WHATSAPP_GATEWAY_HOST, () =>
    logger.info(
      { port: config.WHATSAPP_GATEWAY_PORT, host: config.WHATSAPP_GATEWAY_HOST },
      'gateway listening',
    ),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    gateway.close();
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('starting WhatsApp client (first run downloads/launches Chromium)…');
  await transport.start();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
