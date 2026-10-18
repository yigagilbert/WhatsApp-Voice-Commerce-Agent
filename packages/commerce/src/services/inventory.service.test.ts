import { describe, expect, it } from 'vitest';
import { stockStatus } from './inventory.service';

describe('stockStatus', () => {
  it.each([
    [{ stockQuantity: null, reorderLevel: 10 }, 'NOT_TRACKED'],
    [{ stockQuantity: 0, reorderLevel: 10 }, 'OUT_OF_STOCK'],
    [{ stockQuantity: -2, reorderLevel: null }, 'OUT_OF_STOCK'],
    [{ stockQuantity: 10, reorderLevel: 10 }, 'LOW'],
    [{ stockQuantity: 11, reorderLevel: 10 }, 'OK'],
    [{ stockQuantity: 3, reorderLevel: null }, 'OK'],
  ] as const)('%j → %s', (product, expected) => {
    expect(stockStatus(product)).toBe(expected);
  });
});
