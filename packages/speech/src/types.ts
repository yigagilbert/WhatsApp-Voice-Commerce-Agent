/**
 * Provider-neutral speech contracts. Whisper, Sunbird AI, MMS or any other engine plugs in
 * by implementing these interfaces — the pipeline and the rest of the system never change.
 * Language codes are BCP-47 tags ("en", "lg" for Luganda, "sw" for Swahili).
 */
export interface AudioInput {
  data: Buffer;
  /** Normalised MIME type without parameters, e.g. "audio/ogg". */
  mimeType: string;
  filename?: string;
}

export interface TranscriptionResult {
  text: string;
  /** Language reported by (or routed to) the ASR engine, BCP-47 ("en", "lg"). */
  language?: string;
  durationSeconds?: number;
  /** 0..1 estimate of transcription reliability, when the engine exposes one. */
  confidence?: number;
  /** Provider that actually produced the transcript (useful behind a router). */
  provider?: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  transcribe(audio: AudioInput, options?: { languageHint?: string }): Promise<TranscriptionResult>;
}

export interface LanguageDetectionProvider {
  readonly id: string;
  detect(text: string): Promise<{ language: string; confidence?: number }>;
}

export interface TranslationProvider {
  readonly id: string;
  translate(text: string, options: { from?: string; to: string }): Promise<{ text: string }>;
}

/** Reserved for spoken replies (voice-note responses) — not used yet. */
export interface TextToSpeechProvider {
  readonly id: string;
  synthesize(text: string, options: { language: string }): Promise<AudioInput>;
}

/** Converts arbitrary input audio into a format the ASR provider handles best. */
export interface AudioNormalizer {
  readonly id: string;
  normalize(audio: AudioInput): Promise<AudioInput>;
}
