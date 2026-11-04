'use client';

import { MAX_LINE_QUANTITY } from '@/lib/storefront-types';
import { useCart } from './cart-context';
import s from '../shop.module.css';

/** The quick-add on a product photo: shows how many are in the cart once there are any. */
export function AddButton({ productId, name }: { productId: string; name: string }) {
  const { items, add } = useCart();
  const inCart = items.find((i) => i.productId === productId)?.quantity ?? 0;
  const full = inCart >= MAX_LINE_QUANTITY;
  return (
    <button
      type="button"
      className={`${s.quickAdd} ${inCart ? s.quickAddOn : ''}`}
      disabled={full}
      onClick={() => add(productId)}
      aria-label={
        inCart ? `Add another ${name}. ${inCart} in your cart` : `Add ${name} to your cart`
      }
    >
      {inCart ? (
        <span>{inCart}</span>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
