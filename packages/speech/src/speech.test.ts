import { describe, expect, it } from 'vitest';
import { decodeAudioMedia, normalizeMimeType } from './media';
import { toLanguageCode } from './openai-stt';
import { SpeechPipeline } from './pipeline';
import type { SpeechToTextProvider, TranslationProvider } from './types';

const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]).toString('base64');

describe('decodeAudioMedia', () => {
  it('accepts WhatsApp voice notes', () => {
    const decoded = decodeAudioMedia({
      dataBase64: ogg,
      mimeType: 'audio/ogg; codecs=opus',
      maxBytes: 1024,
    });
    expect(decoded.mimeType).toBe('audio/ogg');
    expect(decoded.data.subarray(0, 4).toString()).toBe('OggS');
  });

  it('rejects disallowed types, oversize payloads, bad base64 and spoofed content', () => {
    expect(() =>
      decodeAudioMedia({ dataBase64: ogg, mimeType: 'application/pdf', maxBytes: 1024 }),
    ).toThrow(/Unsupported/);
    expect(() => decodeAudioMedia({ dataBase64: ogg, mimeType: 'audio/ogg', maxBytes: 4 })).toThrow(
      /limit/,
    );
    expect(() =>
      decodeAudioMedia({ dataBase64: '@@@', mimeType: 'audio/ogg', maxBytes: 1024 }),
    ).toThrow(/base64/);
    const notOgg = Buffer.from('MZ-executable').toString('base64');
    expect(() =>
      decodeAudioMedia({ dataBase64: notOgg, mimeType: 'audio/ogg', maxBytes: 1024 }),
    ).toThrow(/OGG/);
  });

  it('normalizes mime types', () => {
    expect(normalizeMimeType('Audio/OGG; codecs=opus')).toBe('audio/ogg');
  });
});

describe('SpeechPipeline', () => {
  const stt = (text: string, language?: string): SpeechToTextProvider => ({
    id: 'fake-stt',
    transcribe: async () => ({ text, ...(language ? { language } : {}) }),
  });
  const translator: TranslationProvider = {
    id: 'fake-mt',
    translate: async (text) => ({ text: `[en] ${text}` }),
  };
  const audio = { data: Buffer.from('x'), mimeType: 'audio/ogg' };

  it('passes English through unchanged', async () => {
    const result = await new SpeechPipeline({
      stt: stt('Create an order', 'en'),
      translator,
    }).process(audio);
    expect(result).toMatchObject({
      transcript: 'Create an order',
      language: 'en',
      normalizedText: 'Create an order',
    });
  });

  it('keeps the original transcript and translates configured languages into the working language', async () => {
    const result = await new SpeechPipeline({
      stt: stt('Kola order', 'lg'),
      translator,
      translateLanguages: ['lg'],
    }).process(audio);
    expect(result).toMatchObject({
      transcript: 'Kola order',
      language: 'lg',
      normalizedText: '[en] Kola order',
    });
    expect(result.providers).toEqual({ stt: 'fake-stt', translation: 'fake-mt' });
  });

  it('maps Whisper language names to codes', () => {
    expect(toLanguageCode('english')).toBe('en');
    expect(toLanguageCode('Swahili')).toBe('sw');
    expect(toLanguageCode(undefined)).toBeUndefined();
  });
});
