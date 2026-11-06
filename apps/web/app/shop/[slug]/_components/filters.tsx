'use client';

import { useEffect, useRef } from 'react';
import { catalogueUrl, type CatalogueState } from '@/lib/storefront-types';
import { useShopNavigation } from './navigation';
import s from '../shop.module.css';

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'newest', label: 'Newest' },
];

export type { CatalogueState as Current };

/** Searches as the customer types on the catalogue; elsewhere it submits to the catalogue. */
export function SearchBox({
  slug,
  current,
  live,
  id,
  className,
}: {
  slug: string;
  current: CatalogueState;
  live: boolean;
  id: string;
  className?: string;
}) {
  const { go } = useShopNavigation();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <form action={`/shop/${slug}`} role="search" className={`${s.search} ${className ?? ''}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <label htmlFor={id} className="sr-only">
        Search products
      </label>
      <input
        id={id}
        name="q"
        type="search"
        defaultValue={current.q}
        placeholder="Search products"
        autoComplete="off"
        enterKeyHint="search"
        onChange={(event) => {
          if (!live) return;
          const q = event.target.value.trim();
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(
            () =>
              go(catalogueUrl(slug, { ...current, q }), {
                kind: 'results',
                replace: true,
                scroll: false,
              }),
            280,
          );
        }}
      />
      {current.preview && <input type="hidden" name="preview" value="1" />}
      {/* The catalogue's own search box keeps the customer's filters; elsewhere it starts afresh. */}
      {live && current.category && <input type="hidden" name="category" value={current.category} />}
      {live && current.sort !== 'name' && <input type="hidden" name="sort" value={current.sort} />}
      {live && current.inStock && <input type="hidden" name="inStock" value="1" />}
    </form>
  );
}

export function SortAndStock({ slug, current }: { slug: string; current: CatalogueState }) {
  const { go } = useShopNavigation();
  const change = (next: Partial<CatalogueState>) =>
    go(catalogueUrl(slug, { ...current, ...next }), {
      kind: 'results',
      replace: true,
      scroll: false,
    });
  return (
    <div className={s.controls}>
      <label className={s.inStock}>
        <input
          type="checkbox"
          checked={current.inStock}
          onChange={(event) => change({ inStock: event.target.checked })}
        />
        In stock
      </label>
      <label className={s.sort}>
        <span className="sr-only">Sort products</span>
        <select value={current.sort} onChange={(event) => change({ sort: event.target.value })}>
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
