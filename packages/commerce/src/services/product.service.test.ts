import { describe, expect, it } from 'vitest';
import { matchProduct } from './product.service';

const catalog = [
  { name: 'Handmade Basket', sku: 'KC-BASKET' },
  { name: 'Barkcloth Wallet', sku: 'KC-WALLET' },
  { name: 'Coffee Gift Pack', sku: 'KC-COFFEE' },
];

describe('matchProduct', () => {
  it.each([
    ['handmade baskets', 'Handmade Basket'],
    ['baskets', 'Handmade Basket'],
    ['Barkcloth wallets', 'Barkcloth Wallet'],
    ['coffee gift packs', 'Coffee Gift Pack'],
    ['KC-WALLET', 'Barkcloth Wallet'],
  ])('maps %j to %j', (spoken, expected) => {
    expect(matchProduct(catalog, spoken)?.name).toBe(expected);
  });

  it('returns null for unknown or ambiguous items', () => {
    expect(matchProduct(catalog, 'ceramic vase')).toBeNull();
    expect(matchProduct([...catalog, { name: 'Small Basket', sku: null }], 'basket')).toBeNull();
  });
});
