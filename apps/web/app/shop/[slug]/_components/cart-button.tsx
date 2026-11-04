'use client';

import { useCart } from './cart-context';
import s from '../shop.module.css';

export function CartButton() {
  const { count, openDrawer, ready } = useCart();
  return (
    <button
      type="button"
      className={s.iconButton}
      onClick={openDrawer}
      aria-label={count ? `Open your cart, ${count} items` : 'Open your cart'}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <path
          d="M4.5 7.5h13l-1 10.2a1 1 0 0 1-1 .8h-9a1 1 0 0 1-1-.8l-1-10.2Zm3.5 0V6a3 3 0 0 1 6 0v1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {ready && count > 0 && (
        <span key={count} className={s.cartCount}>
          {count}
        </span>
      )}
    </button>
  );
}
