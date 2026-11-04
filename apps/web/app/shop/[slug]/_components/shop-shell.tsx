import Link from 'next/link';
import type { ReactNode } from 'react';
import { catalogueUrl, shopHref, type PublicShop } from '@/lib/storefront-types';
import { CartDrawer } from './cart-drawer';
import { CartButton } from './cart-button';
import { SearchBox, type Current } from './filters';
import { ShopLink } from './navigation';
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
      width={32}
      height={32}
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
  const active = current.category.toLowerCase();
  // Changing category keeps the search and filters the customer already chose.
  const tab = (category: string) =>
    catalogueUrl(shop.slug, { ...current, category, ...(liveSearch ? {} : { q: '' }) });
  return (
    <>
      <a href="#products" className={s.skip}>
        Skip to products
      </a>
      {shop.preview && (
        <p className={s.previewBar} role="status">
          Preview: only you can see this shop. Customers can&apos;t until you publish it, and the
          cart is off here.
        </p>
      )}
      <header className={s.header}>
        <div className={s.headerRow}>
          <ShopLink href={shopHref(shop.slug, shop.preview)} className={s.brand}>
            <ShopLogo shop={shop} />
            <span>{shop.name}</span>
          </ShopLink>
          <SearchBox
            slug={shop.slug}
            current={current}
            live={liveSearch}
            id="shop-search"
            className={s.searchDesktop}
          />
          <div className={s.headerActions}>
            {!liveSearch && (
              <ShopLink
                href={shopHref(shop.slug, shop.preview)}
                className={`${s.iconButton} ${s.searchLink}`}
                aria-label="Search products"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </ShopLink>
            )}
            {!shop.preview && <CartButton />}
          </div>
        </div>
        {shop.categories.length > 0 && (
          <nav className={s.tabs} aria-label="Categories">
            <ShopLink
              href={tab('')}
              kind={liveSearch ? 'results' : 'page'}
              className={!active ? s.tabOn : s.tab}
              aria-current={!active ? 'page' : undefined}
            >
              All products
            </ShopLink>
            {shop.categories.map((category) => {
              const on = active === category.name.toLowerCase();
              return (
                <ShopLink
                  key={category.name}
                  href={tab(category.name)}
                  kind={liveSearch ? 'results' : 'page'}
                  className={on ? s.tabOn : s.tab}
                  aria-current={on ? 'page' : undefined}
                >
                  {category.name}
                </ShopLink>
              );
            })}
          </nav>
        )}
      </header>
      <main className={s.main}>{children}</main>
      <footer className={s.footer}>
        <div className={s.footerInner}>
          <section aria-labelledby="how-to-order">
            <h2 id="how-to-order">How ordering works</h2>
            <ol className={s.steps}>
              <li>Add what you like to your cart. You don&apos;t need an account.</li>
              <li>Tap Checkout on WhatsApp and send the message that opens.</li>
              <li>
                Katale AI, the assistant for {shop.name}, confirms delivery and sends a secure
                PayPal link.
              </li>
            </ol>
          </section>
          {(shop.shopInfo || shop.about) && (
            <section aria-labelledby="shop-info">
              <h2 id="shop-info">About {shop.name}</h2>
              <p className={s.shopInfo}>{shop.shopInfo ?? shop.about}</p>
            </section>
          )}
        </div>
        <p className={s.powered}>
          {shop.name} runs on <Link href="/">Katale AI</Link>.
        </p>
      </footer>
      {!shop.preview && (
        <CartDrawer shopName={shop.name} checkoutAvailable={shop.checkoutAvailable} />
      )}
    </>
  );
}
