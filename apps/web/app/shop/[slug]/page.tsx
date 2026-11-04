import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { siteUrl } from '@/lib/public-site';
import { fetchProducts, fetchShop } from '@/lib/storefront';
import { SortAndStock, type Current } from './_components/filters';
import { LoadMore } from './_components/load-more';
import { ProductCard } from './_components/product-card';
import { ShopShell } from './_components/shop-shell';
import s from './shop.module.css';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const SORTS = new Set(['name', 'price_asc', 'price_desc', 'newest']);

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const { slug } = await params;
  const search = await searchParams;
  const preview = one(search.preview) === '1';
  const shop = await fetchShop(slug, preview);
  if (!shop) return { title: 'Shop not found', robots: { index: false } };
  const origin = await siteUrl();
  const category = one(search.category);
  const title = category ? `${category} at ${shop.name}` : shop.name;
  const description =
    shop.tagline ??
    shop.about ??
    `Browse ${shop.totalProducts} products from ${shop.name} and order on WhatsApp.`;
  const canonical = `${origin}/shop/${slug}${category ? `?category=${encodeURIComponent(category)}` : ''}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    robots: preview || one(search.q) ? { index: false, follow: true } : undefined,
    openGraph: {
      type: 'website',
      siteName: shop.name,
      title,
      description,
      url: canonical,
      ...(shop.logoVersion
        ? { images: [`${origin}/shop/${slug}/api/logo?v=${shop.logoVersion}`] }
        : {}),
    },
  };
}

/** The catalogue: every filter is in the URL, so results can be shared and work without JavaScript. */
export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const search = await searchParams;
  const preview = one(search.preview) === '1';
  const shop = await fetchShop(slug, preview);
  if (!shop) notFound();

  const q = one(search.q).trim().slice(0, 100);
  const category = one(search.category).slice(0, 60);
  const sort = SORTS.has(one(search.sort)) ? one(search.sort) : 'name';
  const inStock = one(search.inStock) === '1';
  const requestedPage = Number(one(search.page)) || 1;

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (category) query.set('category', category);
  if (sort !== 'name') query.set('sort', sort);
  if (inStock) query.set('inStock', '1');
  const baseQuery = query.toString();
  const pageQuery = new URLSearchParams(query);
  if (requestedPage > 1) pageQuery.set('page', String(Math.floor(requestedPage)));

  const result = await fetchProducts(slug, pageQuery, preview);
  if (!result) notFound();

  const current: Current = { q, category, sort, inStock, preview };
  const narrowed = !!(q || category || inStock || result.page > 1);
  const categoryHref = (name: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (name) params.set('category', name);
    if (sort !== 'name') params.set('sort', sort);
    if (inStock) params.set('inStock', '1');
    if (preview) params.set('preview', '1');
    const text = params.toString();
    return `/shop/${slug}${text ? `?${text}` : ''}`;
  };

  return (
    <ShopShell shop={shop} current={current} liveSearch>
      <section className={narrowed ? s.mastheadCompact : s.masthead}>
        <div className={s.mastheadInner}>
          <h1>{category || shop.name}</h1>
          {!narrowed && shop.tagline && <p className={s.tagline}>{shop.tagline}</p>}
          {!narrowed && shop.about && <p className={s.about}>{shop.about}</p>}
        </div>
      </section>

      {shop.categories.length > 0 && (
        <nav className={s.chips} aria-label="Categories">
          <Link
            href={categoryHref(null)}
            className={!category ? s.chipOn : s.chip}
            aria-current={!category ? 'page' : undefined}
          >
            All
          </Link>
          {shop.categories.map((c) => (
            <Link
              key={c.name}
              href={categoryHref(c.name)}
              className={category.toLowerCase() === c.name.toLowerCase() ? s.chipOn : s.chip}
              aria-current={category.toLowerCase() === c.name.toLowerCase() ? 'page' : undefined}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}

      <div className={s.toolbar} id="products">
        <p className={s.count} role="status">
          {result.total.toLocaleString('en')} {result.total === 1 ? 'product' : 'products'}
          {q && <> for “{q}”</>}
        </p>
        <SortAndStock slug={slug} current={current} />
      </div>

      {result.products.length ? (
        <>
          <ul className={s.grid} key={baseQuery}>
            {result.products.map((product, index) => (
              <ProductCard
                key={product.id}
                slug={slug}
                product={product}
                preview={preview}
                eager={index < 4}
              />
            ))}
          </ul>
          <LoadMore
            key={`${baseQuery}:${result.page}`}
            slug={slug}
            query={baseQuery}
            page={result.page}
            pages={result.pages}
            preview={preview}
          />
        </>
      ) : (
        <div className={s.empty}>
          <p>{q ? `Nothing matches “${q}”.` : 'No products here yet.'}</p>
          {(q || category || inStock) && (
            <Link href={`/shop/${slug}${preview ? '?preview=1' : ''}`} className={s.ghostButton}>
              See all products
            </Link>
          )}
        </div>
      )}
    </ShopShell>
  );
}
