/**
 * EXTERNAL (opt-in) — real speech-to-text + real LLM on the voice evaluation set:
 *   pnpm test:voice:external
 * Each synthetic English clip goes through the production speech pipeline (Whisper, plus the
 * Sunbird cascade when SUNBIRD_API_KEY is set) and then the real model's tool selection.
 * Reports per-clip word error rate and latency. Never part of `pnpm verify`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnvFile, parseConfig, speechSchema } from '@vca/config';
import {
  CascadeSpeechToText,
  OpenAICompatibleSpeechToText,
  SpeechPipeline,
  SunbirdSpeechToText,
} from '@vca/speech';
import { args, interpret } from '../support/interpret';

loadEnvFile();
const config = parseConfig(speechSchema);
const evaluation = JSON.parse(readFileSync('tests/evaluation/voice-commerce.json', 'utf8')) as {
  cases: {
    id: string;
    language: string;
    audio: string;
    reference: string;
    expectedTool: string | null;
    expectedQuantity?: number;
    expectedUnitPrice?: number;
    expectedShipping?: number;
    expectedPeriod?: string;
    expectedReplyPattern?: string;
  }[];
};

const NUMBERS: Record<string, string> = {
  ten: '10',
  twelve: '12',
  twenty: '20',
  'one thousand': '1000',
};
/** Normalise for WER: lowercase, spell-out numbers → digits, drop punctuation and "$". */
const words = (s: string) => {
  let t = s
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/[$,.?!']/g, ' ');
  for (const [w, d] of Object.entries(NUMBERS)) t = t.replaceAll(w, d);
  return t.split(/\s+/).filter(Boolean);
};
/** Word error rate via Levenshtein distance over words. */
export function wer(reference: string, hypothesis: string): number {
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from(
    { length: r.length + 1 },
    (_, i) => [i, ...Array(h.length).fill(0)] as number[],
  );
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
  return d[r.length]![h.length]! / Math.max(1, r.length);
}

const enabled = !!config.STT_API_KEY && !!process.env.AI_API_KEY;

describe.skipIf(!enabled)('Voice commerce evaluation (real STT + LLM)', () => {
  const whisper = new OpenAICompatibleSpeechToText({
    baseUrl: config.STT_BASE_URL,
    apiKey: config.STT_API_KEY!,
    model: config.STT_MODEL,
  });
  const stt = config.SUNBIRD_API_KEY
    ? new CascadeSpeechToText({
        primary: whisper,
        primaryLanguages: ['en'],
        secondary: {
          language: 'lg',
          provider: new SunbirdSpeechToText({
            baseUrl: config.SUNBIRD_API_URL,
            apiKey: config.SUNBIRD_API_KEY,
            defaultLanguage: 'lg',
          }),
        },
      })
    : whisper;
  const pipeline = new SpeechPipeline({
    stt,
    maxDurationSeconds: config.VOICE_MAX_DURATION_SECONDS,
  });

  for (const c of evaluation.cases.filter((x) => x.language === 'en')) {
    it(`${c.id}: transcribes and drives the right action`, async () => {
      const started = Date.now();
      const speech = await pipeline.process({ data: readFileSync(c.audio), mimeType: 'audio/ogg' });
      const errorRate = wer(c.reference, speech.transcript);
      const { calls, text } = await interpret(speech.normalizedText, {
        fromVoice: true,
        ...(speech.language ? { messageLanguage: speech.language } : {}),
      });
      console.log(
        JSON.stringify({
          id: c.id,
          transcript: speech.transcript,
          language: speech.language,
          confidence: speech.confidence,
          audioSeconds: speech.audioSeconds,
          sttMs: speech.sttMs,
          wer: Math.round(errorRate * 100) / 100,
          tools: calls.map((x) => x.name),
          voiceToDecisionMs: Date.now() - started,
        }),
      );

      expect(speech.language).toBe('en');
      expect(errorRate).toBeLessThanOrEqual(0.15);
      if (c.expectedTool) {
        const call = calls.find((x) => x.name === c.expectedTool);
        expect(call, `tools: ${calls.map((x) => x.name).join(',')} | ${text}`).toBeDefined();
        const a = args(call);
        if (c.expectedQuantity !== undefined) expect(a.items[0].quantity).toBe(c.expectedQuantity);
        if (c.expectedUnitPrice !== undefined)
          expect(a.items[0].unit_price).toBe(c.expectedUnitPrice);
        if (c.expectedShipping !== undefined) expect(a.shipping).toBe(c.expectedShipping);
        if (c.expectedPeriod !== undefined) expect(a.period).toBe(c.expectedPeriod);
      } else {
        expect(calls.some((x) => ['create_draft_order', 'request_payment'].includes(x.name))).toBe(
          false,
        );
        if (c.expectedReplyPattern)
          expect(text.toLowerCase()).toMatch(new RegExp(c.expectedReplyPattern));
      }
    });
  }
});
