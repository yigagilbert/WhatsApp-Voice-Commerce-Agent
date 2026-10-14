import { ProviderError } from '@vca/shared';
import { extensionForMimeType } from './media';
import type {
  AudioInput,
  SpeechToTextProvider,
  TranscriptionResult,
  TranslationProvider,
} from './types';

/** Sunbird uses ISO 639-3; the rest of Katale uses BCP-47 two-letter codes where they exist. */
const ISO3_TO_BCP47: Record<string, string> = {
  eng: 'en',
  lug: 'lg',
  swa: 'sw',
  nyn: 'nyn',
  ach: 'ach',
  teo: 'teo',
  lgg: 'lgg',
};
const BCP47_TO_ISO3: Record<string, string> = Object.fromEntries(
  Object.entries(ISO3_TO_BCP47).map(([k, v]) => [v, k]),
);

export const toSunbirdLanguage = (code: string): string => BCP47_TO_ISO3[code] ?? code;
export const fromSunbirdLanguage = (code: string | undefined): string | undefined =>
  code ? (ISO3_TO_BCP47[code.toLowerCase()] ?? code.toLowerCase()) : undefined;

export interface SunbirdOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

async function call<T>(options: SunbirdOptions, path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.apiKey}`, ...init.headers },
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (cause) {
    throw new ProviderError('sunbird', 'request failed', { cause });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProviderError('sunbird', `HTTP ${response.status}`, { details: detail });
  }
  return (await response.json()) as T;
}

/**
 * Sunbird AI speech-to-text (Whisper-based ASR for 51 African languages incl. Luganda).
 * POST /tasks/audio/transcriptions, multipart `audio` + required ISO 639-3 `language`.
 * Accepts WhatsApp's Ogg/Opus directly.
 */
export class SunbirdSpeechToText implements SpeechToTextProvider {
  readonly id: string;

  constructor(private readonly options: SunbirdOptions & { defaultLanguage?: string }) {
    this.id = `sunbird:${options.defaultLanguage ?? 'lg'}`;
  }

  async transcribe(
    audio: AudioInput,
    options: { languageHint?: string } = {},
  ): Promise<TranscriptionResult> {
    const language = toSunbirdLanguage(
      options.languageHint ?? this.options.defaultLanguage ?? 'lg',
    );
    const form = new FormData();
    form.append(
      'audio',
      new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
      audio.filename ?? `audio.${extensionForMimeType(audio.mimeType)}`,
    );
    form.append('language', language);
    const json = await call<{
      audio_transcription?: string;
      language?: string;
      duration_seconds?: number;
    }>(this.options, '/tasks/audio/transcriptions', { method: 'POST', body: form });
    if (typeof json.audio_transcription !== 'string')
      throw new ProviderError('sunbird', 'response had no transcription');
    const detected = fromSunbirdLanguage(json.language ?? language);
    return {
      text: json.audio_transcription.trim(),
      provider: `sunbird:${language}`,
      ...(detected ? { language: detected } : {}),
      ...(typeof json.duration_seconds === 'number'
        ? { durationSeconds: json.duration_seconds }
        : {}),
    };
  }
}

/** Sunbird AI translation (Sunflower). POST /tasks/translate → output.translated_text. */
export class SunbirdTranslator implements TranslationProvider {
  readonly id = 'sunbird-translate';

  constructor(private readonly options: SunbirdOptions) {}

  async translate(text: string, options: { from?: string; to: string }): Promise<{ text: string }> {
    const json = await call<{ output?: { translated_text?: string } | null }>(
      this.options,
      '/tasks/translate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(options.from ? { source_language: toSunbirdLanguage(options.from) } : {}),
          target_language: toSunbirdLanguage(options.to),
          text,
        }),
      },
    );
    const translated = json.output?.translated_text;
    if (typeof translated !== 'string' || !translated.trim())
      throw new ProviderError('sunbird', 'translation had no text');
    return { text: translated.trim() };
  }
}
