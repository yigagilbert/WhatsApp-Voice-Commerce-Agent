import type { AuditService } from '@vca/commerce';
import type { Database } from '@vca/database';
import { isAppError, type InboundChannelMessage, type Logger } from '@vca/shared';
import {
  AudioTooLongError,
  decodeAudioMedia,
  type SpeechPipeline,
  type SpeechPipelineResult,
} from '@vca/speech';
import { isLikelyHallucination } from '../customer/intents';
import { copy } from './copy';

/** Below this Whisper is hearing noise, not a badly recorded sentence. Clean speech scores 0.6+. */
const NOISE_CONFIDENCE = 0.15;
/** Words Whisper is told to expect, so "Ntinda" isn't heard as "Nintendo". */
const LOCAL_PLACES =
  'Kampala, Ntinda, Kololo, Nakasero, Bukoto, Kira, Najjera, Kansanga, Muyenga, Makindye, Nansana, Bweyogerere, Naalya, Entebbe, Jinja, Gulu, Mbarara, Wakiso, Mukono';
const PROMPT_MAX_CHARS = 600;

export type Heard = 'clear' | 'unclear' | 'noise';

/** Is a transcript usable, worth reading back, or just noise? */
export function judgeTranscript(
  result: Pick<SpeechPipelineResult, 'transcript' | 'confidence' | 'language'>,
  minConfidence: number,
  languages: string[],
): Heard {
  const { transcript, confidence, language } = result;
  const phrase = isLikelyHallucination(transcript);
  if (!transcript.trim()) return 'noise';
  if (confidence !== undefined && confidence < NOISE_CONFIDENCE) return 'noise';
  if (phrase && (confidence === undefined || confidence < minConfidence)) return 'noise';
  if (language && !languages.includes(language)) return 'unclear';
  if (confidence !== undefined && confidence < minConfidence) return 'unclear';
  return 'clear';
}

/** Voice note → text, for merchants and customers alike. Failures come back as a message to send. */
export class VoiceNotes {
  constructor(
    private readonly deps: {
      db: Pick<Database, 'product'>;
      audit: Pick<AuditService, 'record'>;
      speech: SpeechPipeline | null;
      mediaMaxBytes: number;
      voiceMaxDurationSeconds: number;
      logger: Logger;
    },
  ) {}

  get enabled() {
    return !!this.deps.speech;
  }

  /** The shop's own product names and local places, to bias recognition towards them. */
  private async prompt(merchantId: string) {
    const products = await this.deps.db.product.findMany({
      where: { merchantId, active: true },
      select: { name: true },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });
    const names = products.map((p) => p.name).join(', ');
    return `${names ? `${names}. ` : ''}${LOCAL_PLACES}.`.slice(0, PROMPT_MAX_CHARS);
  }

  async transcribe(message: InboundChannelMessage, merchantId: string) {
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
        prompt: await this.prompt(merchantId),
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
      // Provider outage/timeout: no details reach the sender.
      this.deps.logger.warn({ err: error }, 'voice note processing failed');
      return { error: copy.voiceUnavailable } as const;
    }
    await this.deps.audit.record({
      merchantId,
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
}
