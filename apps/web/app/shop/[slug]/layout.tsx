import type { ReactNode } from 'react';
import { CartProvider } from './_components/cart-context';
import s from './shop.module.css';

/** A merchant's public storefront: keeps the cart while the customer moves between pages. */
export default async function ShopLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div className={s.shop}>
      <CartProvider slug={slug}>{children}</CartProvider>
    </div>
  );
}
