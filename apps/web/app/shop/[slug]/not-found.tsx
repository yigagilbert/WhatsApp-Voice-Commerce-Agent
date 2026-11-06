'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import s from './shop.module.css';

/** A missing product stays in the shop. Only a shop that doesn't exist leads away from it. */
export default function ShopNotFound() {
  const { slug } = useParams<{ slug: string }>();
  const shopPath = `/shop/${slug}`;
  const productMissing = usePathname() !== shopPath;
  return (
    <main className={s.missing}>
      <h1>This page isn&apos;t here</h1>
      <p>
        {productMissing
          ? 'This product may no longer be on sale.'
          : 'This shop may have moved or closed.'}
      </p>
      <Link href={productMissing ? shopPath : '/'} className={s.secondary}>
        {productMissing ? 'See all products' : 'Go to Katale AI'}
      </Link>
    </main>
  );
}
