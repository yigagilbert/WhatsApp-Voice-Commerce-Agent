import { describe, expect, it } from 'vitest';
import { closestMatches } from './similarity';

describe('closestMatches (did-you-mean for misheard speech)', () => {
  const customers = ['Sarah Thompson', 'James Carter'];
  const products = ['Handmade Basket', 'Barkcloth Wallet', 'Coffee Gift Pack'];

  it.each([
    ['ssaala', customers, 'Sarah Thompson'],
    ['jams', customers, 'James Carter'],
    ['buckets', products, 'Handmade Basket'],
    ['koffi gift', products, 'Coffee Gift Pack'],
  ])('%s → %s', (query, candidates, expected) => {
    expect(closestMatches(query, candidates)[0]).toBe(expected);
  });

  it('suggests nothing for unrelated words', () => {
    expect(closestMatches('shoes', products)).toEqual([]);
    expect(closestMatches('', customers)).toEqual([]);
  });
});
