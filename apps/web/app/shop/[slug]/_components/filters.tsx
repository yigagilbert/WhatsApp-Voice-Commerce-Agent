'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';
import s from '../shop.module.css';

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'price_asc', label: 'Price, low to high' },
  { value: 'price_desc', label: 'Price, high to low' },
  { value: 'newest', label: 'Newest' },
];

export interface Current {
  q: string;
  category: string;
  sort: string;
  inStock: boolean;
  preview: boolean;
}

const catalogueUrl = (slug: string, c: Partial<Current>) => {
  const params = new URLSearchParams();
  if (c.q) params.set('q', c.q);
  if (c.category) params.set('category', c.category);
  if (c.sort && c.sort !== 'name') params.set('sort', c.sort);
  if (c.inStock) params.set('inStock', '1');
  if (c.preview) params.set('preview', '1');
  const query = params.toString();
  return `/shop/${slug}${query ? `?${query}` : ''}`;
};

/** Searches as the customer types on the catalogue; from a product page, submits to the catalogue. */
export function SearchBox({
  slug,
  current,
  live,
}: {
  slug: string;
  current: Current;
  live: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <form
      action={`/shop/${slug}`}
      role="search"
      className={s.search}
      data-pending={pending || undefined}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <label htmlFor="shop-search" className="sr-only">
        Search products
      </label>
      <input
        id="shop-search"
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
              start(() => router.replace(catalogueUrl(slug, { ...current, q }), { scroll: false })),
            280,
          );
        }}
      />
      {current.preview && <input type="hidden" name="preview" value="1" />}
    </form>
  );
}

export function SortAndStock({ slug, current }: { slug: string; current: Current }) {
  const router = useRouter();
  const [, start] = useTransition();
  const go = (change: Partial<Current>) =>
    start(() => router.replace(catalogueUrl(slug, { ...current, ...change }), { scroll: false }));
  return (
    <div className={s.controls}>
      <label className={s.inStock}>
        <input
          type="checkbox"
          checked={current.inStock}
          onChange={(event) => go({ inStock: event.target.checked })}
        />
        In stock only
      </label>
      <label className={s.sort}>
        <span className="sr-only">Sort products</span>
        <select value={current.sort} onChange={(event) => go({ sort: event.target.value })}>
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
