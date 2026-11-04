'use client';

import s from './shop.module.css';

export default function ShopError({ reset }: { reset: () => void }) {
  return (
    <main className={s.missing}>
      <h1>The shop isn&apos;t responding</h1>
      <p>Your cart is saved in this browser. Try loading the page again.</p>
      <button type="button" className={s.ghostButton} onClick={reset}>
        Try again
      </button>
    </main>
  );
}
