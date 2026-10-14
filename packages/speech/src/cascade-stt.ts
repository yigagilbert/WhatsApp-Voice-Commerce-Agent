import type { AudioInput, SpeechToTextProvider, TranscriptionResult } from './types';

/**
 * "Fast path first" routing for merchants who speak English or a local language:
 *   1. transcribe with the primary engine (Whisper: fast, detects the language);
 *   2. if it heard one of its own languages (English), keep that result — even when confidence is
 *      low, so the inbound pipeline reads it back to the merchant instead of re-guessing;
 *   3. otherwise (another language, or no words) transcribe with the local-language engine
 *      (Sunbird, Luganda). Whisper does not support Luganda and labels it as some other
 *      language, which is exactly the signal used to switch.
 * If the local engine returns nothing, the primary result is kept.
 */
export class CascadeSpeechToText implements SpeechToTextProvider {
  readonly id: string;

  constructor(
    private readonly deps: {
      primary: SpeechToTextProvider;
      /** Languages the primary engine is trusted for (BCP-47), e.g. ['en']. */
      primaryLanguages: string[];
      secondary: { language: string; provider: SpeechToTextProvider };
    },
  ) {
    this.id = `cascade(${deps.primary.id}->${deps.secondary.language}:${deps.secondary.provider.id})`;
  }

  async transcribe(
    audio: AudioInput,
    options: { languageHint?: string } = {},
  ): Promise<TranscriptionResult> {
    const { primary, primaryLanguages, secondary } = this.deps;
    if (options.languageHint === secondary.language) {
      return this.secondary(audio);
    }
    const first = await primary.transcribe(audio, options);
    const heardPrimaryLanguage =
      first.text.trim() !== '' &&
      first.language !== undefined &&
      primaryLanguages.includes(first.language);
    if (heardPrimaryLanguage) return { ...first, provider: first.provider ?? primary.id };

    const second = await this.secondary(audio);
    if (second.text.trim()) return second;
    return { ...first, provider: first.provider ?? primary.id };
  }

  private async secondary(audio: AudioInput): Promise<TranscriptionResult> {
    const { language, provider } = this.deps.secondary;
    const result = await provider.transcribe(audio, { languageHint: language });
    return {
      ...result,
      language: result.language ?? language,
      provider: result.provider ?? provider.id,
    };
  }
}
