import { describe, expect, it } from 'vitest';
import type { ChatModel } from '@vca/ai';
import {
  aiCopy,
  copyProblem,
  CTAS,
  nextCta,
  pickProduct,
  templateCaption,
  templateHeadline,
} from './copy';

const model = (content: string): ChatModel => ({
  id: 'fake',
  complete: async () => ({ message: { role: 'assistant', content } }),
});
const tote = { name: 'Woven Tote', description: 'A raffia tote with leather handles. Roomy.' };

describe('copyProblem', () => {
  it.each([
    ['50% off this week', 'numbers'],
    ['Big sale on totes', 'discounts'],
    ['Get yours for $5', 'numbers'],
    ['Free delivery with every tote', 'discounts'],
    ['Hurry, limited stock', 'urgency'],
    ['The best tote in town', 'claims'],
    ['Organic and handmade', 'product claims'],
    ['Special offer today', 'discounts'],
    ['Только сегодня', 'not in English'],
  ])('rejects "%s"', (text, reason) => {
    expect(copyProblem(text, 'Woven Tote')).toContain(reason);
  });

  it('accepts plain inviting copy, emoji included', () => {
    expect(copyProblem('Carry your market day in style 🧺', 'Woven Tote')).toBeNull();
  });

  it('allows a claim the shop itself wrote in the product name or description', () => {
    expect(copyProblem('Fresh organic honey', 'Organic Honey\nFrom our hives')).toBeNull();
    expect(copyProblem('Fresh organic honey', 'Wild Honey')).toContain('product claims');
  });
});

describe('templates and rotation', () => {
  it('builds a caption from the product facts and the call to action', () => {
    expect(templateCaption(tote, 'Message us to order')).toBe(
      'Woven Tote\nA raffia tote with leather handles.\nMessage us to order 💬',
    );
    expect(templateCaption({ name: 'Mug', description: null }, CTAS[0])).toBe(`Mug\n${CTAS[0]} 💬`);
  });

  it('avoids recent headlines and the most recent CTAs', () => {
    const first = templateHeadline([], 0);
    expect(templateHeadline([first], 0)).not.toBe(first);
    expect(nextCta([])).toBe(CTAS[0]);
    expect(nextCta([CTAS[0], CTAS[1]])).toBe(CTAS[2]);
    // All used: the one used longest ago comes back.
    expect(nextCta([...CTAS].reverse())).toBe(CTAS[0]);
  });

  it('picks the product featured least recently, not one already featured today', () => {
    const products = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const today = new Date('2026-11-01T00:00:00Z');
    const last = new Map([
      ['a', new Date('2026-10-30T09:00:00Z')],
      ['b', new Date('2026-11-01T09:00:00Z')],
    ]);
    expect(pickProduct(products, last, today)?.id).toBe('c');
    last.set('c', new Date('2026-10-31T09:00:00Z'));
    expect(pickProduct(products, last, today)?.id).toBe('a');
    expect(pickProduct([], last, today)).toBeNull();
    // Only one product, already featured today: it is still used rather than nothing.
    expect(pickProduct([products[1]!], last, today)?.id).toBe('b');
  });
});

describe('aiCopy', () => {
  const cta = 'Message us to order';
  it('uses good AI copy and keeps the call to action', async () => {
    const { copy } = await aiCopy(
      model(
        '{"headline":"Market days made easy","caption":"A roomy raffia tote. Message us to order"}',
      ),
      tote,
      cta,
      [],
    );
    expect(copy).toEqual({
      headline: 'Market days made easy',
      caption: 'A roomy raffia tote. Message us to order',
      source: 'ai',
    });
  });

  it.each([
    ['{"headline":"20% off totes","caption":"Grab one. Message us to order"}', 'numbers'],
    ['{"headline":"Weekend deal","caption":"Message us to order"}', 'discounts'],
    ['not json at all', 'not JSON'],
    ['{"headline":"Hi"}', 'missing fields'],
    [`{"headline":"Today’s pick","caption":"Nice. ${cta}"}`, 'repeats'],
  ])('rejects %s', async (content, reason) => {
    const result = await aiCopy(model(content), tote, cta, ['Today’s pick']);
    expect(result.copy).toBeNull();
    expect(result.rejected).toContain(reason);
  });

  it('appends the call to action if the model left it out', async () => {
    const { copy } = await aiCopy(
      model('{"headline":"Carry it all","caption":"A roomy raffia tote."}'),
      tote,
      cta,
      [],
    );
    expect(copy?.caption).toBe(`A roomy raffia tote.\n${cta} 💬`);
  });

  it('returns nothing without a model', async () => {
    expect((await aiCopy(null, tote, cta, [])).copy).toBeNull();
  });
});
