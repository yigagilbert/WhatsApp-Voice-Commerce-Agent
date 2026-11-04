import Link from 'next/link';
import type { ReactNode } from 'react';
import { shopHref, type PublicShop } from '@/lib/storefront-types';
import { CartDrawer } from './cart-drawer';
import { CartButton } from './cart-button';
import { SearchBox, type Current } from './filters';
import s from '../shop.module.css';

export function ShopLogo({ shop }: { shop: PublicShop }) {
  if (!shop.logoVersion)
    return (
      <span className={s.logoMark} aria-hidden="true">
        {shop.name.slice(0, 1)}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={s.logoMark}
      src={`/shop/${shop.slug}/api/logo?v=${shop.logoVersion}${shop.preview ? '&preview=1' : ''}`}
      alt=""
      width={40}
      height={40}
    />
  );
}

/** Header, footer and cart around every storefront page. */
export function ShopShell({
  shop,
  current,
  liveSearch,
  children,
}: {
  shop: PublicShop;
  current: Current;
  liveSearch: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <a href="#products" className={s.skip}>
        Skip to products
      </a>
      {shop.preview && (
        <p className={s.previewBar} role="status">
          Preview: only you can see this shop. Customers can&apos;t until you publish it, and the
          cart is switched off here.
        </p>
      )}
      <header className={s.bar}>
        <Link href={shopHref(shop.slug, shop.preview)} className={s.brand}>
          <ShopLogo shop={shop} />
          <span>{shop.name}</span>
        </Link>
        <SearchBox slug={shop.slug} current={current} live={liveSearch} />
        {!shop.preview && <CartButton />}
      </header>
      <main>{children}</main>
      <footer className={s.footer}>
        <div className={s.footerInner}>
          <section aria-labelledby="how-to-order">
            <h2 id="how-to-order">How ordering works</h2>
            <ol className={s.steps}>
              <li>Add what you like to your cart. No account needed.</li>
              <li>Tap Checkout on WhatsApp and send the message that opens.</li>
              <li>Confirm your delivery details and pay securely with PayPal in the chat.</li>
            </ol>
          </section>
          {shop.shopInfo && (
            <section aria-labelledby="shop-info">
              <h2 id="shop-info">About {shop.name}</h2>
              <p className={s.shopInfo}>{shop.shopInfo}</p>
            </section>
          )}
        </div>
        <p className={s.powered}>
          Runs on <Link href="/">Katale AI</Link>. Prices and stock come straight from the shop.
        </p>
      </footer>
      {!shop.preview && (
        <CartDrawer shopName={shop.name} checkoutAvailable={shop.checkoutAvailable} />
      )}
    </>
  );
}
