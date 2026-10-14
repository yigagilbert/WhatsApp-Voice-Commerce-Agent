import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AudioTooLongError, oggOpusDurationSeconds } from './media';
import { whisperConfidence } from './openai-stt';
import { SpeechPipeline } from './pipeline';
import { CascadeSpeechToText } from './cascade-stt';
import { SunbirdSpeechToText, SunbirdTranslator } from './sunbird';
import type { SpeechToTextProvider, TranslationProvider } from './types';

const fixture = readFileSync(join(__dirname, '../../../tests/fixtures/voice/en-order-001.ogg'));

/** Minimal Ogg/Opus container: OpusHead (pre-skip 312) + a last page with the given granule. */
function syntheticOgg(granule: bigint): Buffer {
  const page = (granulePos: bigint, payload: Buffer) => {
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'latin1');
    header.writeBigInt64LE(granulePos, 6);
    return Buffer.concat([header, payload]);
  };
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head.writeUInt16LE(312, 10);
  return Buffer.concat([
    page(0n, head),
    page(-1n, Buffer.alloc(10)),
    page(granule, Buffer.alloc(10)),
  ]);
}

const fakeStt = (
  text: string,
  extra: Partial<Awaited<ReturnType<SpeechToTextProvider['transcribe']>>> = {},
) => {
  const transcribe = vi.fn(async () => ({ text, ...extra }));
  return { id: 'fake-stt', transcribe } satisfies SpeechToTextProvider;
};

describe('oggOpusDurationSeconds', () => {
  it('reads the duration of a real Opus voice note (matches ffprobe ≈5.29s)', () => {
    expect(oggOpusDurationSeconds(fixture)).toBeCloseTo(5.28, 1);
  });

  it('subtracts pre-skip and skips "no packet" pages (granule -1)', () => {
    expect(oggOpusDurationSeconds(syntheticOgg(48_000n * 61n + 312n))).toBeCloseTo(61, 3);
  });

  it('returns undefined for non-Ogg/non-Opus data', () => {
    expect(
      oggOpusDurationSeconds(Buffer.from('ID3 not an ogg file at all, just bytes')),
    ).toBeUndefined();
  });
});

describe('whisperConfidence', () => {
  it('maps avg_logprob to 0..1, weighted by duration', () => {
    expect(whisperConfidence([{ start: 0, end: 4, avg_logprob: -0.2 }])).toBeCloseTo(
      Math.exp(-0.2),
      3,
    );
    const mixed = whisperConfidence([
      { start: 0, end: 1, avg_logprob: -0.1 },
      { start: 1, end: 4, avg_logprob: -2 },
    ]);
    expect(mixed).toBeLessThan(0.4);
  });

  it('treats probable non-speech as zero confidence and is undefined without segments', () => {
    expect(whisperConfidence([{ start: 0, end: 2, avg_logprob: -0.1, no_speech_prob: 0.9 }])).toBe(
      0,
    );
    expect(whisperConfidence(undefined)).toBeUndefined();
  });
});

describe('SpeechPipeline voice limits and metrics', () => {
  it('rejects audio over the limit BEFORE calling speech-to-text', async () => {
    const stt = fakeStt('never');
    const pipeline = new SpeechPipeline({ stt, maxDurationSeconds: 60 });
    await expect(
      pipeline.process({ data: syntheticOgg(48_000n * 75n), mimeType: 'audio/ogg' }),
    ).rejects.toBeInstanceOf(AudioTooLongError);
    expect(stt.transcribe).not.toHaveBeenCalled();
  });

  it('uses the channel duration hint for non-Ogg audio, and the ASR duration as a last check', async () => {
    const stt = fakeStt('hi', { durationSeconds: 90 });
    const pipeline = new SpeechPipeline({ stt, maxDurationSeconds: 60 });
    const mp3 = { data: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' };
    await expect(pipeline.process(mp3, { durationHintSeconds: 70 })).rejects.toBeInstanceOf(
      AudioTooLongError,
    );
    expect(stt.transcribe).not.toHaveBeenCalled();
    await expect(pipeline.process(mp3)).rejects.toBeInstanceOf(AudioTooLongError);
  });

  it('reports transcript, language, confidence, audio length and timings', async () => {
    const stt = fakeStt('Create an order', { language: 'en', confidence: 0.81 });
    const result = await new SpeechPipeline({ stt, maxDurationSeconds: 60 }).process({
      data: fixture,
      mimeType: 'audio/ogg',
    });
    expect(result).toMatchObject({
      transcript: 'Create an order',
      normalizedText: 'Create an order',
      language: 'en',
      confidence: 0.81,
      audioSeconds: 5.3,
    });
    expect(result.sttMs).toBeGreaterThanOrEqual(0);
  });

  it('applies per-language text normalisers to normalizedText but keeps the original transcript', async () => {
    const result = await new SpeechPipeline({
      stt: fakeStt('shipping ya dollar abiri', { language: 'lg' }),
      textNormalizers: { lg: (t) => t.replace('abiri', '20') },
    }).process({ data: fixture, mimeType: 'audio/ogg' });
    expect(result.transcript).toBe('shipping ya dollar abiri');
    expect(result.normalizedText).toBe('shipping ya dollar 20');
  });

  it('does not translate languages that are not configured for translation', async () => {
    const translator: TranslationProvider = {
      id: 'mt',
      translate: vi.fn(async () => ({ text: 'x' })),
    };
    const result = await new SpeechPipeline({
      stt: fakeStt('Nsaba', { language: 'lg' }),
      translator,
    }).process({
      data: fixture,
      mimeType: 'audio/ogg',
    });
    expect(result.normalizedText).toBe('Nsaba');
    expect(translator.translate).not.toHaveBeenCalled();
  });
});

describe('CascadeSpeechToText', () => {
  const audio = { data: fixture, mimeType: 'audio/ogg' };
  const make = (
    first: Awaited<ReturnType<SpeechToTextProvider['transcribe']>>,
    second = 'Nsaba okukola order',
  ) => {
    const whisper = fakeStt(first.text, first);
    const sunbird = fakeStt(second, { provider: 'sunbird:lug' });
    return {
      whisper,
      sunbird,
      stt: new CascadeSpeechToText({
        primary: whisper,
        primaryLanguages: ['en'],
        secondary: { language: 'lg', provider: sunbird },
      }),
    };
  };

  it('keeps English (fast path) without calling the local-language engine', async () => {
    const { stt, sunbird } = make({ text: 'Create an order', language: 'en', confidence: 0.8 });
    expect(await stt.transcribe(audio)).toMatchObject({ text: 'Create an order', language: 'en' });
    expect(sunbird.transcribe).not.toHaveBeenCalled();
  });

  it('keeps low-confidence English for read-back instead of re-guessing as Luganda', async () => {
    const { stt, sunbird } = make({
      text: 'Create an order for fifty',
      language: 'en',
      confidence: 0.2,
    });
    expect(await stt.transcribe(audio)).toMatchObject({ language: 'en', confidence: 0.2 });
    expect(sunbird.transcribe).not.toHaveBeenCalled();
  });

  it('switches to Luganda when Whisper hears another language (it cannot transcribe Luganda)', async () => {
    const { stt, sunbird } = make({ text: 'Nsaba okukola', language: 'sw', confidence: 0.3 });
    expect(await stt.transcribe(audio)).toMatchObject({
      text: 'Nsaba okukola order',
      language: 'lg',
      provider: 'sunbird:lug',
    });
    expect(sunbird.transcribe).toHaveBeenCalledWith(audio, { languageHint: 'lg' });
  });

  it('falls back to the primary result when the local engine hears nothing', async () => {
    const { stt } = make({ text: 'hmm', language: 'sw' }, '');
    expect((await stt.transcribe(audio)).text).toBe('hmm');
  });
});

describe('Sunbird providers', () => {
  it('sends Ogg audio with ISO 639-3 language codes and maps results back to BCP-47', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ audio_transcription: ' Nsaba ', language: 'lug', duration_seconds: 4.2 }),
      );
    }) as unknown as typeof fetch;
    const stt = new SunbirdSpeechToText({
      baseUrl: 'https://api.sunbird.ai/',
      apiKey: 'k',
      fetch: fetchImpl,
    });
    const result = await stt.transcribe(
      { data: fixture, mimeType: 'audio/ogg' },
      { languageHint: 'lg' },
    );
    expect(result).toEqual({
      text: 'Nsaba',
      provider: 'sunbird:lug',
      language: 'lg',
      durationSeconds: 4.2,
    });
    expect(calls[0]!.url).toBe('https://api.sunbird.ai/tasks/audio/transcriptions');
    expect((calls[0]!.init.body as FormData).get('language')).toBe('lug');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('translates via output.translated_text and surfaces failures as provider errors', async () => {
    const ok = new SunbirdTranslator({
      baseUrl: 'https://api.sunbird.ai',
      apiKey: 'k',
      fetch: (async () =>
        new Response(
          JSON.stringify({ output: { translated_text: 'Create an order' } }),
        )) as unknown as typeof fetch,
    });
    expect(await ok.translate('Nsaba', { from: 'lg', to: 'en' })).toEqual({
      text: 'Create an order',
    });
    const down = new SunbirdTranslator({
      baseUrl: 'https://api.sunbird.ai',
      apiKey: 'k',
      fetch: (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(down.translate('x', { to: 'en' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});
