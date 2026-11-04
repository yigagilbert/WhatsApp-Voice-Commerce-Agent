import type { Viewport } from 'next';
import type { ReactNode } from 'react';
import { CartProvider } from './_components/cart-context';
import { ShopNavigation } from './_components/navigation';
import s from './shop.module.css';

export const viewport: Viewport = { themeColor: '#ffffff', colorScheme: 'light' };

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
      <CartProvider slug={slug}>
        <ShopNavigation>{children}</ShopNavigation>
      </CartProvider>
    </div>
  );
}
