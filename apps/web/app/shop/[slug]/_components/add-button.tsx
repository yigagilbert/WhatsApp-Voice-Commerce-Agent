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
      onClick={() => add(productId, 1, name)}
      aria-label={
        inCart ? `Add another ${name}. ${inCart} in your cart` : `Add ${name} to your cart`
      }
    >
      {inCart ? (
        <span key={inCart}>{inCart}</span>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 2.5v11M2.5 8h11"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
