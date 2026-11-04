import Link from 'next/link';
import s from './shop.module.css';

export default function ShopNotFound() {
  return (
    <main className={s.missing}>
      <h1>This page isn&apos;t here</h1>
      <p>The shop may have moved, or the product is no longer on sale.</p>
      <Link href="/" className={s.ghostButton}>
        Go to Katale AI
      </Link>
    </main>
  );
}
