import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toMajorString } from '@vca/commerce/money';
import { siteUrl } from '@/lib/public-site';
import { fetchProduct, fetchShop } from '@/lib/storefront';
import { productImage, shopHref } from '@/lib/storefront-types';
import { BuyPanel } from '../../_components/buy-panel';
import { ShopLink } from '../../_components/navigation';
import { PhotoZoom } from '../../_components/photo-zoom';
import { NoPhoto, ProductCard } from '../../_components/product-card';
import { ShopShell } from '../../_components/shop-shell';
import s from '../../shop.module.css';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ preview?: string }>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug, id } = await params;
  const preview = (await searchParams).preview === '1';
  const [shop, product] = await Promise.all([
    fetchShop(slug, preview),
    fetchProduct(slug, id, preview),
  ]);
  if (!shop || !product) return { title: 'Product not found', robots: { index: false } };
  const origin = await siteUrl();
  const title = `${product.name} at ${shop.name}`;
  const description =
    product.description ??
    `${product.name}, ${product.price}. Order on WhatsApp from ${shop.name}.`;
  const url = `${origin}/shop/${slug}/p/${id}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots: preview ? { index: false } : undefined,
    openGraph: {
      type: 'website',
      siteName: shop.name,
      title,
      description,
      url,
      ...(product.imageVersion
        ? { images: [`${origin}${productImage(slug, id, product.imageVersion, 'main')}`] }
        : {}),
    },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug, id } = await params;
  const preview = (await searchParams).preview === '1';
  const [shop, product] = await Promise.all([
    fetchShop(slug, preview),
    fetchProduct(slug, id, preview),
  ]);
  if (!shop || !product) notFound();
  const soldOut = product.availability === 'Out of stock';
  const origin = await siteUrl();
  const question = shop.whatsappNumber
    ? `https://wa.me/${shop.whatsappNumber}?text=${encodeURIComponent(`Hi! I have a question about ${product.name}.`)}`
    : null;
  const bargain = shop.whatsappNumber
    ? `https://wa.me/${shop.whatsappNumber}?text=${encodeURIComponent(`Hi! Can you do a better price on ${product.name}?`)}`
    : null;
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    ...(product.category ? { category: product.category } : {}),
    ...(product.imageVersion
      ? { image: `${origin}${productImage(slug, id, product.imageVersion, 'main')}` }
      : {}),
    offers: {
      '@type': 'Offer',
      // Currency-aware: UGX has no minor unit, so dividing by 100 would publish 500 for 50,000.
      price: toMajorString(product.priceMinor, product.currency),
      priceCurrency: product.currency,
      availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: `${origin}/shop/${slug}/p/${id}`,
    },
  };

  return (
    <ShopShell
      shop={shop}
      current={{ q: '', category: product.category ?? '', sort: 'name', inStock: false, preview }}
      liveSearch={false}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structured).replace(/</g, '\\u003c'),
        }}
      />
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <ShopLink href={shopHref(slug, preview)}>All products</ShopLink>
        {product.category && (
          <>
            <span aria-hidden="true">/</span>
            <ShopLink
              href={`/shop/${slug}?category=${encodeURIComponent(product.category)}${preview ? '&preview=1' : ''}`}
            >
              {product.category}
            </ShopLink>
          </>
        )}
      </nav>
      <article className={s.detail} id="products">
        <div className={s.detailPhoto}>
          {product.imageVersion ? (
            <PhotoZoom
              src={productImage(slug, id, product.imageVersion, 'main', preview)}
              alt={product.name}
            />
          ) : (
            <NoPhoto />
          )}
        </div>
        <div className={s.detailBody}>
          <h1>{product.name}</h1>
          <p className={s.detailPrice}>{product.price}</p>
          <p
            className={
              soldOut ? s.stockOut : product.availability === 'Low stock' ? s.stockLow : s.stockIn
            }
          >
            {product.availability}
          </p>
          {product.description && <p className={s.description}>{product.description}</p>}
          <BuyPanel
            productId={product.id}
            name={product.name}
            disabled={soldOut || shop.preview}
            disabledLabel={soldOut ? 'Out of stock' : 'Add to cart (off in preview)'}
          />
          {product.deals.length > 0 && (
            <ul className={s.deals}>
              {product.deals.map((deal) => (
                <li key={deal.minQuantity}>
                  Buy {deal.minQuantity} or more and get {deal.percentOff}% off each
                </li>
              ))}
            </ul>
          )}
          <ul className={s.assurances}>
            <li>Order in WhatsApp with Katale AI, the assistant for {shop.name}</li>
            <li>Pay securely with PayPal</li>
            {product.negotiable && !soldOut && bargain && (
              <li>
                Price open to offers.{' '}
                <a href={bargain} target="_blank" rel="noopener noreferrer">
                  Ask for a better price
                </a>
              </li>
            )}
            {question && (
              <li>
                <a href={question} target="_blank" rel="noopener noreferrer">
                  Ask a question about this product
                </a>
              </li>
            )}
          </ul>
        </div>
      </article>
      {product.related.length > 0 && (
        <section className={s.related} aria-labelledby="related">
          <h2 id="related">More in {product.category}</h2>
          <ul className={s.grid}>
            {product.related.map((item) => (
              <ProductCard key={item.id} slug={slug} product={item} preview={preview} />
            ))}
          </ul>
        </section>
      )}
    </ShopShell>
  );
}
