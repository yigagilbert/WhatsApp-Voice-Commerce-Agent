'use client';

import { useState } from 'react';
import type { ProductPage, PublicProduct } from '@/lib/storefront-types';
import { ProductCard } from './product-card';
import s from '../shop.module.css';

/**
 * Further pages, added below the server-rendered first page. The link is a real URL, so it also
 * works without JavaScript and for search engines; only the current page's products are loaded.
 */
export function LoadMore({
  slug,
  query,
  page,
  pages,
  preview,
}: {
  slug: string;
  query: string;
  page: number;
  pages: number;
  preview: boolean;
}) {
  const [extra, setExtra] = useState<PublicProduct[]>([]);
  const [current, setCurrent] = useState(page);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  const nextHref = () => {
    const params = new URLSearchParams(query);
    params.set('page', String(current + 1));
    if (preview) params.set('preview', '1');
    return `/shop/${slug}?${params}`;
  };

  const loadNext = async (event: React.MouseEvent) => {
    // The owner's preview isn't public, so its pages go through the server-rendered link.
    if (preview) return;
    event.preventDefault();
    setState('loading');
    try {
      const params = new URLSearchParams(query);
      params.set('page', String(current + 1));
      const res = await fetch(`/shop/${slug}/api/products?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as ProductPage;
      setExtra((list) => {
        const seen = new Set(list.map((p) => p.id));
        return [...list, ...body.products.filter((p) => !seen.has(p.id))];
      });
      setCurrent(body.page);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <>
      {extra.length > 0 && (
        <ul className={`${s.grid} ${s.gridMore}`}>
          {extra.map((product) => (
            <ProductCard key={product.id} slug={slug} product={product} preview={preview} />
          ))}
        </ul>
      )}
      <div className={s.more} aria-live="polite">
        {state === 'error' && <p className={s.stockOut}>Products could not load. Try again.</p>}
        {current < pages && (
          <a
            href={nextHref()}
            onClick={loadNext}
            className={s.ghostButton}
            aria-disabled={state === 'loading'}
          >
            {state === 'loading' ? 'Loading products…' : 'Show more products'}
          </a>
        )}
      </div>
    </>
  );
}
