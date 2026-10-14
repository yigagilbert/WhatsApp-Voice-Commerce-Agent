import { AudioTooLongError, oggOpusDurationSeconds } from './media';
import type {
  AudioInput,
  AudioNormalizer,
  LanguageDetectionProvider,
  SpeechToTextProvider,
  TranslationProvider,
} from './types';

export interface SpeechPipelineResult {
  /** Raw ASR output in the spoken language (never overwritten). */
  transcript: string;
  /** Detected language (BCP-47), if known. */
  language?: string;
  /** Text handed to the agent — translated into the working language when a translator is configured. */
  normalizedText: string;
  /** 0..1 when the ASR engine reports it. */
  confidence?: number;
  /** Audio length from the container (Ogg/Opus), the channel or the ASR engine. */
  audioSeconds?: number;
  /** Time spent in the ASR call. */
  sttMs: number;
  /** Whole pipeline time. */
  totalMs: number;
  providers: { stt: string; normalizer?: string; languageDetection?: string; translation?: string };
}

/**
 * Voice note → (duration check) → (normalised audio) → ASR → (language ID) → (translation) → text.
 * Each stage is an injectable provider; optional stages are skipped when not configured.
 * Throws AudioTooLongError before any ASR call when the audio exceeds `maxDurationSeconds`.
 */
export class SpeechPipeline {
  constructor(
    private readonly deps: {
      stt: SpeechToTextProvider;
      normalizer?: AudioNormalizer;
      languageDetector?: LanguageDetectionProvider;
      translator?: TranslationProvider;
      /** Language the agent works in. */
      workingLanguage?: string;
      /** Languages translated into the working language (default: none — the LLM reads them). */
      translateLanguages?: string[];
      maxDurationSeconds?: number;
      /** Deterministic per-language text normalisers (e.g. Luganda number words → digits). */
      textNormalizers?: Record<string, (text: string) => string>;
    },
  ) {}

  async process(
    audio: AudioInput,
    options: { languageHint?: string; durationHintSeconds?: number } = {},
  ): Promise<SpeechPipelineResult> {
    const started = Date.now();
    const { stt, normalizer, languageDetector, translator, maxDurationSeconds } = this.deps;
    const workingLanguage = this.deps.workingLanguage ?? 'en';

    const measured =
      (audio.mimeType === 'audio/ogg' || audio.mimeType === 'audio/opus'
        ? oggOpusDurationSeconds(audio.data)
        : undefined) ?? options.durationHintSeconds;
    if (maxDurationSeconds && measured !== undefined && measured > maxDurationSeconds) {
      throw new AudioTooLongError(measured, maxDurationSeconds);
    }

    const prepared = normalizer ? await normalizer.normalize(audio) : audio;
    const sttStarted = Date.now();
    const transcription = await stt.transcribe(
      prepared,
      options.languageHint ? { languageHint: options.languageHint } : {},
    );
    const sttMs = Date.now() - sttStarted;

    const audioSeconds = measured ?? transcription.durationSeconds;
    // Duration unknown up front (non-Ogg formats): enforce the limit before anything acts on it.
    if (
      maxDurationSeconds &&
      measured === undefined &&
      audioSeconds !== undefined &&
      audioSeconds > maxDurationSeconds + 1
    ) {
      throw new AudioTooLongError(audioSeconds, maxDurationSeconds);
    }

    let language = transcription.language;
    if (!language && languageDetector && transcription.text) {
      language = (await languageDetector.detect(transcription.text)).language;
    }

    let normalizedText = transcription.text;
    const normalize = language ? this.deps.textNormalizers?.[language] : undefined;
    if (normalize && normalizedText) normalizedText = normalize(normalizedText);
    const translate = this.deps.translateLanguages ?? [];
    if (
      translator &&
      language &&
      language !== workingLanguage &&
      translate.includes(language) &&
      transcription.text
    ) {
      normalizedText = (
        await translator.translate(transcription.text, { from: language, to: workingLanguage })
      ).text;
    }

    return {
      transcript: transcription.text,
      ...(language ? { language } : {}),
      normalizedText,
      ...(transcription.confidence !== undefined ? { confidence: transcription.confidence } : {}),
      ...(audioSeconds !== undefined ? { audioSeconds: Math.round(audioSeconds * 10) / 10 } : {}),
      sttMs,
      totalMs: Date.now() - started,
      providers: {
        stt: transcription.provider ?? stt.id,
        ...(normalizer ? { normalizer: normalizer.id } : {}),
        ...(languageDetector ? { languageDetection: languageDetector.id } : {}),
        ...(translator && normalizedText !== transcription.text
          ? { translation: translator.id }
          : {}),
      },
    };
  }
}
