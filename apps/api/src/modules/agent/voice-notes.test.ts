import { describe, expect, it } from 'vitest';
import { judgeTranscript } from './voice-notes';

const judge = (transcript: string, confidence?: number, language?: string) =>
  judgeTranscript(
    {
      transcript,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(language ? { language } : {}),
    },
    0.5,
    ['en'],
  );

describe('judgeTranscript', () => {
  it.each([
    ['Thank you for watching.', 0],
    ['you', 0],
    ['', 0.9],
    ['anything at all', 0.1],
    ['Thank you for watching.', undefined],
    ['Bye.', 0.3],
  ])('treats %s at %s as noise', (text, confidence) => {
    expect(judge(text, confidence)).toBe('noise');
  });

  it('reads back low confidence and other languages', () => {
    expect(judge('send me two baskets', 0.4)).toBe('unclear');
    expect(judge('nkwagala ebibbo bibiri', 0.9, 'lg')).toBe('unclear');
  });

  it('accepts clean speech, including a real "thank you"', () => {
    expect(judge('show me two baskets', 0.7, 'en')).toBe('clear');
    expect(judge('Thank you', 0.8, 'en')).toBe('clear');
    expect(judge('show me two baskets')).toBe('clear');
  });
});
