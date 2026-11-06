'use client';

import s from './shop.module.css';

export default function ShopError({ retry }: { retry: () => void }) {
  return (
    <main className={s.missing}>
      <h1>The shop isn&apos;t responding</h1>
      <p>Your cart is saved in this browser. Try loading the page again.</p>
      <button type="button" className={s.secondary} onClick={() => retry()}>
        Try again
      </button>
    </main>
  );
}
