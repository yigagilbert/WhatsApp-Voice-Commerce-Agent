import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { siteUrl } from '@/lib/public-site';
import { fetchProduct, fetchShop } from '@/lib/storefront';
import { productImage, shopHref } from '@/lib/storefront-types';
import { BuyPanel } from '../../_components/buy-panel';
import { ProductCard } from '../../_components/product-card';
import { ShopShell } from '../../_components/shop-shell';
import { WhatsAppIcon } from '../../_components/whatsapp-icon';
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
      price: (product.priceMinor / 100).toFixed(2),
      priceCurrency: product.currency,
      availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: `${origin}/shop/${slug}/p/${id}`,
    },
  };

  return (
    <ShopShell
      shop={shop}
      current={{ q: '', category: '', sort: 'name', inStock: false, preview }}
      liveSearch={false}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structured).replace(/</g, '\\u003c'),
        }}
      />
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <Link href={shopHref(slug, preview)}>All products</Link>
        {product.category && (
          <>
            <span aria-hidden="true">/</span>
            <Link
              href={`/shop/${slug}?category=${encodeURIComponent(product.category)}${preview ? '&preview=1' : ''}`}
            >
              {product.category}
            </Link>
          </>
        )}
      </nav>
      <article className={s.detail} id="products">
        <div className={s.detailPhoto}>
          {product.imageVersion ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={productImage(slug, id, product.imageVersion, 'main', preview)}
              alt={product.name}
              fetchPriority="high"
            />
          ) : (
            <span className={s.noPhoto} aria-hidden="true">
              {product.name.slice(0, 1)}
            </span>
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
          {product.deals.length > 0 && (
            <ul className={s.deals}>
              {product.deals.map((deal) => (
                <li key={deal.minQuantity}>
                  Buy {deal.minQuantity} or more and get {deal.percentOff}% off each
                </li>
              ))}
            </ul>
          )}
          <BuyPanel
            productId={product.id}
            disabled={soldOut || shop.preview}
            disabledLabel={soldOut ? 'Out of stock' : 'Add to cart (off in preview)'}
          />
          {product.negotiable && !soldOut && bargain && (
            <p className={s.haggle}>
              The price is open to offers.{' '}
              <a href={bargain} target="_blank" rel="noopener noreferrer">
                Ask for a better price on WhatsApp
              </a>
            </p>
          )}
          {product.description && <p className={s.description}>{product.description}</p>}
          {question && (
            <a className={s.questionLink} href={question} target="_blank" rel="noopener noreferrer">
              <WhatsAppIcon size={18} />
              Ask a question about this product
            </a>
          )}
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
