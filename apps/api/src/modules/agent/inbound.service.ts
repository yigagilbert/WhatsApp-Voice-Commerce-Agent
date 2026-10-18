import { runAgent, type ChatMessage, type ChatModel, type ToolRegistry } from '@vca/ai';
import {
  canApprove,
  chatIdToPhone,
  type CustomerIdentityService,
  type WhatsAppAccountService,
  parseConfirmationReply,
  type AdminService,
  type AuditService,
  type ConfirmationService,
} from '@vca/commerce';
import type { Conversation, Database, Merchant } from '@vca/database';
import {
  getContext,
  getCorrelationId,
  isAppError,
  type InboundChannelMessage,
  type InboundProcessingResult,
  type Logger,
} from '@vca/shared';
import {
  AudioTooLongError,
  decodeAudioMedia,
  type SpeechPipeline,
  type SpeechPipelineResult,
} from '@vca/speech';
import type { CustomerConversationService } from '../customer/customer-conversation.service';
import type { ConfirmationExecutor } from './confirmation-executor';
import { approvalWord, copy } from './copy';
import { buildSystemPrompt } from './system-prompt';
import type { AgentContext } from './tools';

/** Recent turns given to the model: enough for short follow-ups ("10", "add $20 shipping"),
 *  bounded in count and age so old topics don't pull new requests off course. */
const HISTORY_LIMIT = 12;
const HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How long an "I heard: … is that right?" transcript waits for the merchant's YES. */
const PENDING_TRANSCRIPT_TTL_MS = 10 * 60 * 1000;

/** The agent's reply text plus any chart images built by tools. */
interface AgentReply {
  text: string;
  attachments: NonNullable<AgentContext['attachments']>;
}

/** Conversation.context — session metadata only, never financial truth. */
interface ConversationContext {
  pendingTranscript?: { text: string; language?: string; messageId: string; at: number };
}

/** Senders remembered for the welcome cooldown (oldest forgotten first). */
const WELCOME_TRACKED_SENDERS = 10_000;

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

export interface InboundServiceDeps {
  db: Database;
  audit: AuditService;
  confirmations: ConfirmationService;
  executor: ConfirmationExecutor;
  tools: ToolRegistry<AgentContext>;
  chatModel: ChatModel | null;
  speech: SpeechPipeline | null;
  mediaMaxBytes: number;
  voiceMaxDurationSeconds: number;
  voiceMinConfidence: number;
  /** Spoken languages handled directly; a note heard in any other language is read back first. */
  voiceLanguages?: string[];
  admins: AdminService;
  /**
   * Customer commerce (all optional; without them every non-admin gets the generic welcome).
   * Customers are served only when the server flag is on AND the receiving bot number is
   * connected to a merchant with customer commerce enabled.
   */
  customers?: {
    enabled: boolean;
    /** E.164 numbers allowed to shop while customer commerce is off (controlled testing). */
    pilotNumbers?: string[];
    accounts: WhatsAppAccountService;
    identity: CustomerIdentityService;
    conversations: CustomerConversationService;
  };
  /** Minimum time between two welcome replies to the same unregistered sender (default 24 h). */
  welcomeCooldownMs?: number;
  logger: Logger;
}

/**
 * Channel-agnostic inbound pipeline:
 *   authorize sender → de-duplicate → (transcribe) → confirmation reply? → agent → store reply
 * Channel adapters (WhatsApp worker, web console) call this through POST /api/agent/message.
 */
export class InboundMessageService {
  private readonly welcomedAt = new Map<string, number>();

  constructor(private readonly deps: InboundServiceDeps) {}

  /** True if an unregistered sender should get the welcome now (once per cooldown per sender). */
  private shouldWelcome(key: string, now = Date.now()): boolean {
    const cooldown = this.deps.welcomeCooldownMs ?? 24 * 60 * 60 * 1000;
    const last = this.welcomedAt.get(key);
    if (last !== undefined && now - last < cooldown) return false;
    this.welcomedAt.delete(key);
    this.welcomedAt.set(key, now);
    if (this.welcomedAt.size > WELCOME_TRACKED_SENDERS) {
      const oldest = this.welcomedAt.keys().next().value;
      if (oldest !== undefined) this.welcomedAt.delete(oldest);
    }
    return true;
  }

  async handle(message: InboundChannelMessage): Promise<InboundProcessingResult> {
    const { db, logger } = this.deps;

    // 1. Only active admins can drive a merchant (matched by chat ID, linked ID or phone).
    //    Anyone else (customers, deactivated admins, strangers) gets the same generic welcome, at
    //    most once per cooldown, and nothing else: no agent, no tools, no data, no lookups, and no
    //    merchant, conversation, message or order is created for them.
    // The bot number that received the message decides the merchant (one number = one shop).
    // When it is connected, only that merchant's admins are admins here.
    const account =
      message.channel === 'whatsapp' && this.deps.customers
        ? await this.deps.customers.accounts.forBot(message.recipientId)
        : null;
    const auth = await this.deps.admins.authorize(
      message.channel,
      message.senderId,
      message.senderPhone,
      account?.merchantId,
    );
    const customers = this.deps.customers;
    const senderPhone = message.senderPhone ?? chatIdToPhone(message.senderId);
    // Pilot numbers (controlled testing) get the customer experience on a connected shop number
    // even while customer shopping is switched off for everyone else.
    const pilot = !!senderPhone && !!customers?.pilotNumbers?.includes(senderPhone);
    if (
      !auth.ok &&
      auth.reason === 'unknown' &&
      account &&
      customers &&
      (pilot || (customers.enabled && account.customerCommerceEnabled))
    ) {
      // A customer of this shop: the customer experience, never the admin agent or its tools.
      const ctx = getContext();
      if (ctx) ctx.merchantId = account.merchantId;
      const identified = await customers.identity.identify(account.merchantId, message);
      return customers.conversations.handle(message, account, identified);
    }
    if (!auth.ok) {
      // Logged (server-side only) so the owner can troubleshoot admin matching; never sent back.
      logger.info(
        { channel: message.channel, senderId: message.senderId, reason: auth.reason },
        'message from unauthorized sender ignored',
      );
      return {
        status: 'ignored',
        replies: this.shouldWelcome(`${message.channel}:${message.senderId}`)
          ? [
              {
                channel: message.channel,
                externalChatId: message.externalChatId,
                text: copy.welcome,
              },
            ]
          : [],
      };
    }
    const operator = auth.operator;
    const merchant = operator.merchant;
    const ctx = getContext();
    if (ctx) ctx.merchantId = merchant.id;

    const conversation = await db.conversation.upsert({
      where: {
        merchantId_channel_externalChatId: {
          merchantId: merchant.id,
          channel: message.channel,
          externalChatId: message.externalChatId,
        },
      },
      update: { lastMessageAt: new Date() },
      create: {
        merchantId: merchant.id,
        channel: message.channel,
        externalChatId: message.externalChatId,
      },
    });

    // 2. De-duplicate on (channel, provider message ID) — the database is the authority.
    let stored;
    try {
      stored = await db.message.create({
        data: {
          conversationId: conversation.id,
          channel: message.channel,
          externalMessageId: message.externalMessageId,
          direction: 'INBOUND',
          type:
            message.type === 'audio'
              ? 'AUDIO'
              : message.type === 'unsupported'
                ? 'UNSUPPORTED'
                : 'TEXT',
          content:
            message.type === 'unsupported' ? `[${message.unsupportedKind}]` : (message.text ?? ''),
          mediaMimeType: message.media?.mimeType ?? null,
          correlationId: getCorrelationId() ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'duplicate', replies: [] };
      throw error;
    }

    await this.deps.audit.record({
      merchantId: merchant.id,
      actor: 'MERCHANT',
      type: 'message.received',
      entityType: 'message',
      entityId: stored.id,
      data: { channel: message.channel, kind: message.type },
    });

    // 3. Content we don't process yet gets a polite, deterministic reply.
    if (message.type === 'unsupported') {
      return this.reply(conversation, copy.unsupported(message.unsupportedKind ?? 'other'));
    }

    // 4. Voice notes → text (only when the speech pipeline is enabled). On any failure we reply
    //    and stop: no tools run, so no draft, confirmation or PayPal request can be created.
    const receivedAt = Date.now();
    let text = message.text?.trim() ?? '';
    let language: string | undefined;
    let voice: SpeechPipelineResult | undefined;
    const context = (conversation.context ?? {}) as ConversationContext;
    const pending = context.pendingTranscript;
    if (pending)
      await this.setContext(conversation.id, { ...context, pendingTranscript: undefined });

    if (message.type === 'audio') {
      const transcription = await this.transcribe(message, merchant);
      if ('error' in transcription) return this.reply(conversation, transcription.error);
      voice = transcription;
      text = transcription.normalizedText.trim();
      language = transcription.language;
      await db.message.update({
        where: { id: stored.id },
        data: {
          transcription: transcription.transcript,
          detectedLanguage: transcription.language ?? null,
          normalizedText: transcription.normalizedText,
        },
      });
    }
    if (!text) return this.reply(conversation, copy.emptyMessage);

    const voiceReply = async (
      reply: string | AgentReply,
      outcome: string,
    ): Promise<InboundProcessingResult> => {
      const { text: replyText, attachments } =
        typeof reply === 'string' ? { text: reply, attachments: [] } : reply;
      if (voice) {
        const metrics = {
          outcome,
          language: voice.language ?? null,
          confidence: voice.confidence ?? null,
          audioSeconds: voice.audioSeconds ?? null,
          sttMs: voice.sttMs,
          voiceToReplyMs: Date.now() - receivedAt,
          provider: voice.providers.stt,
        };
        logger.info(metrics, 'voice note processed');
        await this.deps.audit.record({
          merchantId: merchant.id,
          actor: 'SYSTEM',
          type: 'voice.processed',
          entityType: 'message',
          entityId: stored.id,
          data: metrics,
        });
      }
      return this.reply(conversation, replyText, attachments);
    };

    const confirmationReply = parseConfirmationReply(text);

    if (voice) {
      // Financial approvals are typed, never spoken: a transcribed "yes"/"confirm 1234" is not trusted.
      if (confirmationReply?.kind === 'confirm') {
        const pendingAction = await this.deps.confirmations.findPending(conversation.id);
        if (pendingAction || confirmationReply.code) {
          return voiceReply(
            copy.voiceConfirmationMustBeTyped(
              approvalWord(pendingAction?.action),
              pendingAction?.code,
            ),
            'spoken_confirmation_refused',
          );
        }
      }
      // Unreliable transcription — low confidence, or a language we don't support (English is
      // the supported voice language) — is read back before anything acts on it.
      const supported = this.deps.voiceLanguages ?? ['en'];
      const unsupportedLanguage = !!voice.language && !supported.includes(voice.language);
      if (
        unsupportedLanguage ||
        (voice.confidence !== undefined && voice.confidence < this.deps.voiceMinConfidence)
      ) {
        await this.setContext(conversation.id, {
          ...context,
          pendingTranscript: {
            text,
            ...(language ? { language } : {}),
            messageId: stored.id,
            at: Date.now(),
          },
        });
        return voiceReply(copy.voiceUnclear(voice.transcript), 'low_confidence_readback');
      }
    } else if (
      pending &&
      confirmationReply &&
      !confirmationReply.code &&
      Date.now() - pending.at < PENDING_TRANSCRIPT_TTL_MS
    ) {
      // Typed YES/NO answering "I heard: … is that right?".
      if (confirmationReply.kind === 'cancel')
        return this.reply(conversation, copy.voiceUnclearDismissed);
      text = pending.text;
      language = pending.language;
    } else if (
      confirmationReply &&
      (confirmationReply.code || (await this.deps.confirmations.findPending(conversation.id)))
    ) {
      // 5. Deterministic confirmation handling — never delegated to the LLM. A bare "yes"/"no" is
      //    only treated as a confirmation when this conversation has a pending action (or the
      //    reply quotes a code); otherwise it is an answer to the agent's own question.
      //    Either way, nothing financial executes without a matching pending confirmation.
      return this.reply(
        conversation,
        await this.handleConfirmationReply(
          merchant,
          conversation,
          confirmationReply,
          operator.role,
        ),
      );
    }

    // 6. The agent interprets everything else — identical for typed and transcribed requests.
    try {
      return voiceReply(
        await this.runAgent(
          merchant,
          conversation,
          message.channel,
          text,
          language,
          stored.id,
          !!voice || !!pending,
          operator.role,
        ),
        'agent',
      );
    } catch (error) {
      if (!isAppError(error) || !error.code.startsWith('PROVIDER')) throw error;
      logger.warn({ err: error }, 'agent provider failure');
      return voiceReply(copy.assistantUnavailable, 'agent_unavailable');
    }
  }

  private async setContext(conversationId: string, context: ConversationContext): Promise<void> {
    await this.deps.db.conversation.update({
      where: { id: conversationId },
      data: { context: JSON.parse(JSON.stringify(context)) as object },
    });
  }

  private async transcribe(message: InboundChannelMessage, merchant: Merchant) {
    if (!this.deps.speech) return { error: copy.voiceComingSoon } as const;
    if (!message.media) return { error: copy.voiceDownloadFailed } as const;
    let result: SpeechPipelineResult;
    try {
      const audio = decodeAudioMedia({
        dataBase64: message.media.dataBase64,
        mimeType: message.media.mimeType,
        maxBytes: this.deps.mediaMaxBytes,
      });
      result = await this.deps.speech.process(audio, {
        ...(message.media.durationSeconds !== undefined
          ? { durationHintSeconds: message.media.durationSeconds }
          : {}),
      });
    } catch (error) {
      if (error instanceof AudioTooLongError) {
        this.deps.logger.info({ durationSeconds: error.durationSeconds }, 'voice note too long');
        return { error: copy.voiceTooLong(this.deps.voiceMaxDurationSeconds) } as const;
      }
      if (isAppError(error) && error.httpStatus < 500) {
        this.deps.logger.info({ reason: error.message }, 'voice note rejected');
        return { error: copy.voiceInvalid } as const;
      }
      // Provider outage/timeout: no details reach the merchant.
      this.deps.logger.warn({ err: error }, 'voice note processing failed');
      return { error: copy.voiceUnavailable } as const;
    }
    await this.deps.audit.record({
      merchantId: merchant.id,
      actor: 'SYSTEM',
      type: 'speech.transcribed',
      data: {
        language: result.language ?? null,
        confidence: result.confidence ?? null,
        audioSeconds: result.audioSeconds ?? null,
        sttMs: result.sttMs,
        providers: result.providers,
        transcript: result.transcript.slice(0, 500),
        ...(result.normalizedText !== result.transcript
          ? { normalizedText: result.normalizedText.slice(0, 500) }
          : {}),
      },
    });
    return result;
  }

  private async handleConfirmationReply(
    merchant: Merchant,
    conversation: Conversation,
    reply: NonNullable<ReturnType<typeof parseConfirmationReply>>,
    role: 'OWNER' | 'STAFF' = 'OWNER',
  ): Promise<string> {
    const result = await this.deps.confirmations.claim(merchant.id, conversation.id, reply);
    // Defence in depth: staff never get owner-only proposals, but a role can change while one
    // is pending. Such an approval is refused and nothing runs.
    if (result.status === 'claimed' && !canApprove(role, result.confirmation.action)) {
      await this.deps.confirmations.markFailed(result.confirmation.id, 'owner approval required');
      return copy.ownerOnly;
    }
    switch (result.status) {
      case 'none': {
        if (reply.kind !== 'confirm') return copy.nothingToCancel;
        // A repeated "CONFIRM 4821" (resent or delivered twice): report what it already did.
        const settled = reply.code
          ? await this.deps.confirmations.findSettledByCode(conversation.id, reply.code)
          : null;
        return settled
          ? this.deps.executor.describeSettled(settled, merchant)
          : copy.nothingToConfirm;
      }
      case 'expired':
        return copy.confirmationExpired;
      case 'code_mismatch':
        return copy.codeMismatch(
          approvalWord(result.confirmation.action),
          result.confirmation.code,
        );
      case 'wrong_verb':
        return copy.wrongVerb(approvalWord(result.confirmation.action), result.confirmation.code);
      case 'cancelled':
        return copy.draftDiscarded(await this.deps.executor.discard(result.confirmation, merchant));
      case 'integrity_failed':
        return copy.integrityFailed;
      case 'claimed':
        return this.deps.executor.execute(result.confirmation, merchant);
    }
  }

  private async runAgent(
    merchant: Merchant,
    conversation: Conversation,
    channel: string,
    text: string,
    language: string | undefined,
    currentMessageId: string,
    fromVoice = false,
    operatorRole: 'OWNER' | 'STAFF' = 'OWNER',
  ): Promise<AgentReply> {
    if (!this.deps.chatModel) {
      return { text: copy.aiNotConfigured, attachments: [] };
    }

    const previous = await this.deps.db.message.findMany({
      where: {
        conversationId: conversation.id,
        id: { not: currentMessageId },
        createdAt: { gte: new Date(Date.now() - HISTORY_MAX_AGE_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });
    const history: ChatMessage[] = previous
      .reverse()
      .map((m) =>
        m.direction === 'INBOUND'
          ? { role: 'user' as const, content: m.normalizedText ?? m.content }
          : { role: 'assistant' as const, content: m.content },
      )
      .filter((m) => m.content);

    const startedAt = new Date();
    const context: AgentContext = {
      merchant,
      conversation,
      channel,
      proposals: [],
      notices: [],
      fromVoice,
      operatorRole,
    };
    const result = await runAgent({
      model: this.deps.chatModel,
      tools: this.deps.tools,
      systemPrompt: buildSystemPrompt({
        merchant,
        now: new Date(),
        messageLanguage: language,
        fromVoice,
      }),
      history,
      userMessage: text,
      context,
      logger: this.deps.logger,
    });

    await this.deps.audit.record({
      merchantId: merchant.id,
      actor: 'AGENT',
      type: 'agent.intent_interpreted',
      entityType: 'conversation',
      entityId: conversation.id,
      // Filed at the start of the run so a trace reads in order: interpreted → drafted → …
      at: startedAt,
      data: {
        model: this.deps.chatModel.id,
        stoppedReason: result.stoppedReason,
        tools: result.steps.map((s) => ({
          tool: s.tool,
          ok: s.result.ok,
          durationMs: s.durationMs,
        })),
        proposals: context.proposals.map((p) => p.confirmationId),
      },
    });

    // If a sensitive action was proposed (or refused by policy), the backend's deterministic
    // summary IS the reply — the model never restates amounts for financial actions.
    const attachments = context.attachments ?? [];
    const proposal = context.proposals.at(-1);
    if (proposal) return { text: proposal.prompt, attachments: [] };
    const notice = context.notices.at(-1);
    return { text: notice ?? result.reply, attachments };
  }

  /**
   * Stores and returns the reply. Charts go first, each as an image with the backend's caption;
   * the agent's text follows as its own message.
   */
  private async reply(
    conversation: Conversation,
    text: string,
    attachments: AgentReply['attachments'] = [],
  ): Promise<InboundProcessingResult> {
    const channel = conversation.channel as InboundProcessingResult['replies'][number]['channel'];
    const replies: InboundProcessingResult['replies'] = [
      ...attachments.map((a) => ({
        channel,
        externalChatId: conversation.externalChatId,
        text: a.caption,
        media: a.media,
      })),
      ...(text.trim() ? [{ channel, externalChatId: conversation.externalChatId, text }] : []),
    ];
    for (const r of replies) {
      await this.deps.db.message.create({
        data: {
          conversationId: conversation.id,
          channel: conversation.channel,
          direction: 'OUTBOUND',
          type: 'TEXT',
          // Image bytes are not stored; the transcript records that a chart was sent.
          content: r.media ? `[chart image] ${r.text}` : r.text,
          correlationId: getCorrelationId() ?? null,
        },
      });
    }
    return { status: 'processed', replies };
  }
}
