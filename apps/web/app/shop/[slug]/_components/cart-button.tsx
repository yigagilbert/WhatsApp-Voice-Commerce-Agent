'use client';

import { useCart } from './cart-context';
import s from '../shop.module.css';

export function CartButton() {
  const { count, openDrawer, ready } = useCart();
  return (
    <button
      type="button"
      className={s.cartButton}
      onClick={openDrawer}
      aria-label={count ? `Open your cart, ${count} items` : 'Open your cart'}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M4 6h12l-1 10.5a1 1 0 0 1-1 .9H6a1 1 0 0 1-1-.9L4 6Zm3 0V5a3 3 0 0 1 6 0v1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      {ready && count > 0 && <span className={s.cartCount}>{count}</span>}
    </button>
  );
}
