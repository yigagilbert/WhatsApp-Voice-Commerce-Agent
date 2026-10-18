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

  it('formats numbered lists across pages', () => {
    const product = (n: number) => ({
      id: `p${n}`,
      name: `Item ${n}`,
      price: '$1.00',
      availability: 'In stock' as const,
      description: null,
      hasPhoto: false,
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
