import { describe, expect, it } from 'vitest';
import { displayName } from '@vca/commerce';
import { availability, CustomerCatalog } from './catalog';

describe('customer catalog', () => {
  it('shows availability labels, never quantities', () => {
    expect(availability({ stockQuantity: null, reorderLevel: null })).toBe('In stock');
    expect(availability({ stockQuantity: 40, reorderLevel: 10 })).toBe('In stock');
    expect(availability({ stockQuantity: 10, reorderLevel: 10 })).toBe('Low stock');
    expect(availability({ stockQuantity: 0, reorderLevel: 5 })).toBe('Out of stock');
  });

  it('tells the customer how to add a product to the cart from its details', () => {
    const wallet = {
      id: 'p1',
      name: 'Barkcloth Wallet',
      price: '$18.00',
      availability: 'In stock' as const,
      description: 'Bi-fold wallet in barkcloth',
      hasPhoto: true,
      negotiable: false,
      deals: null,
    };
    expect(CustomerCatalog.formatDetails(wallet)).toContain(
      'Reply *add* to put one in your cart (or e.g. *add 3*)',
    );
    const soldOut = CustomerCatalog.formatDetails({ ...wallet, availability: 'Out of stock' });
    expect(soldOut).not.toContain('*add*');
    expect(soldOut).toContain('Reply *browse* to see other products');
  });

  it('says when a price is open to offers and shows quantity deals, never the minimum', () => {
    const bag = {
      id: 'p2',
      name: 'Leather Bag',
      price: '$30.00',
      availability: 'In stock' as const,
      description: null,
      hasPhoto: false,
      negotiable: true,
      deals: 'buy 3+ and get 5% off each',
    };
    const text = CustomerCatalog.formatDetails(bag);
    expect(text).toContain('💬 Price open to offers');
    expect(text).toContain('🏷️ Deal: buy 3+ and get 5% off each.');
    expect(CustomerCatalog.formatDetails({ ...bag, negotiable: false, deals: null })).not.toMatch(
      /offers|Deal/,
    );
  });

  it('formats numbered lists across pages', () => {
    const product = (n: number) => ({
      id: `p${n}`,
      name: `Item ${n}`,
      price: '$1.00',
      availability: 'In stock' as const,
      description: null,
      hasPhoto: false,
      negotiable: false,
      deals: null,
    });
    const text = CustomerCatalog.formatList({
      query: null,
      total: 10,
      page: 2,
      pages: 2,
      products: [product(9), product(10)],
      ids: [],
    });
    expect(text).toContain('9. Item 9 — $1.00 · In stock');
    expect(text).not.toContain('*more*');
    expect(
      CustomerCatalog.formatList({
        query: 'drum',
        total: 0,
        page: 1,
        pages: 1,
        products: [],
        ids: [],
      }),
    ).toContain('couldn\'t find anything matching "drum"');
  });

  it('treats WhatsApp profile names as untrusted display text', () => {
    expect(displayName('  Sarah\u0007  T. ')).toBe('Sarah T.');
    expect(displayName('')).toBe('WhatsApp customer');
    expect(displayName('x'.repeat(100))).toHaveLength(60);
  });
});
