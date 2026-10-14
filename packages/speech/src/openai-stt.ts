import { ProviderError } from '@vca/shared';
import { extensionForMimeType } from './media';
import type { AudioInput, SpeechToTextProvider, TranscriptionResult } from './types';

export interface OpenAICompatibleSttOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Whisper's verbose_json reports language names; map the ones we care about to BCP-47. */
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  swahili: 'sw',
  french: 'fr',
  arabic: 'ar',
  yoruba: 'yo',
  hausa: 'ha',
  amharic: 'am',
  luganda: 'lg',
  kinyarwanda: 'rw',
  somali: 'so',
  shona: 'sn',
  lingala: 'ln',
};

interface WhisperSegment {
  start?: number;
  end?: number;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/**
 * 0..1 confidence from Whisper's verbose_json segments: duration-weighted mean of
 * exp(avg_logprob), with segments that are probably not speech counted as zero.
 */
export function whisperConfidence(segments: WhisperSegment[] | undefined): number | undefined {
  const usable = (segments ?? []).filter((s) => typeof s.avg_logprob === 'number');
  if (!usable.length) return undefined;
  let weighted = 0;
  let total = 0;
  for (const s of usable) {
    const weight = Math.max(0.1, (s.end ?? 0) - (s.start ?? 0));
    const speech = (s.no_speech_prob ?? 0) > 0.6 ? 0 : Math.exp(s.avg_logprob!);
    weighted += speech * weight;
    total += weight;
  }
  return Math.round((weighted / total) * 1000) / 1000;
}

export const toLanguageCode = (language: string | undefined): string | undefined => {
  if (!language) return undefined;
  const lower = language.toLowerCase();
  return LANGUAGE_NAME_TO_CODE[lower] ?? (lower.length <= 3 ? lower : undefined);
};

/**
 * ASR via an OpenAI-compatible /audio/transcriptions endpoint (OpenAI Whisper,
 * gpt-4o-transcribe, Groq Whisper, faster-whisper servers, ...).
 */
export class OpenAICompatibleSpeechToText implements SpeechToTextProvider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleSttOptions) {
    this.id = `openai-compatible:${options.model}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async transcribe(
    audio: AudioInput,
    options: { languageHint?: string } = {},
  ): Promise<TranscriptionResult> {
    // whisper-* models return the detected language with verbose_json; newer models only support json.
    const verbose = this.options.model.startsWith('whisper');
    const form = new FormData();
    form.append('model', this.options.model);
    form.append('response_format', verbose ? 'verbose_json' : 'json');
    if (options.languageHint) form.append('language', options.languageHint);
    form.append(
      'file',
      new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
      audio.filename ?? `audio.${extensionForMimeType(audio.mimeType)}`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        },
      );
    } catch (cause) {
      throw new ProviderError('stt', 'request failed', { cause });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new ProviderError('stt', `HTTP ${response.status}`, { details: detail });
    }
    const json = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: WhisperSegment[];
    };
    if (typeof json.text !== 'string') throw new ProviderError('stt', 'response had no text');

    const language = toLanguageCode(json.language);
    const confidence = whisperConfidence(json.segments);
    return {
      text: json.text.trim(),
      provider: this.id,
      ...(language ? { language } : {}),
      ...(typeof json.duration === 'number' ? { durationSeconds: json.duration } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
}
