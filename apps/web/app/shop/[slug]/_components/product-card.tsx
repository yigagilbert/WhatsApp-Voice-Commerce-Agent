import { productImage, shopHref, type PublicProduct } from '@/lib/storefront-types';
import { AddButton } from './add-button';
import { ShopLink } from './navigation';
import s from '../shop.module.css';

export function NoPhoto() {
  return (
    <span className={s.noPhoto} aria-hidden="true">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      >
        <rect x="4.5" y="6.5" width="23" height="19" rx="2.5" />
        <circle cx="11.5" cy="13" r="2" />
        <path d="m5 22 6.5-5.5 4.5 3.5 4-3 7 5.5" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function ProductPhoto({
  slug,
  product,
  preview,
  sizes,
  eager,
}: {
  slug: string;
  product: Pick<PublicProduct, 'id' | 'name' | 'imageVersion'>;
  preview: boolean;
  sizes: string;
  eager?: boolean;
}) {
  if (!product.imageVersion) return <NoPhoto />;
  const url = (size: 'thumb' | 'card') =>
    productImage(slug, product.id, product.imageVersion!, size, preview);
  return (
    // Photos come through our own route and already have their final sizes.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url('card')}
      srcSet={`${url('thumb')} 320w, ${url('card')} 640w`}
      sizes={sizes}
      alt={product.name}
      width={640}
      height={640}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
}

export function ProductCard({
  slug,
  product,
  preview,
  eager,
}: {
  slug: string;
  product: PublicProduct;
  preview: boolean;
  eager?: boolean;
}) {
  const soldOut = product.availability === 'Out of stock';
  const href = shopHref(slug, preview, `/p/${product.id}`);
  return (
    <li className={s.card}>
      <div className={`${s.cardPhoto} ${soldOut ? s.cardPhotoOut : ''}`}>
        <ShopLink href={href} tabIndex={-1} aria-hidden="true">
          <ProductPhoto
            slug={slug}
            product={product}
            preview={preview}
            eager={eager ?? false}
            sizes="(min-width: 1100px) 320px, (min-width: 700px) 32vw, 50vw"
          />
        </ShopLink>
        {!soldOut && !preview && <AddButton productId={product.id} name={product.name} />}
      </div>
      <ShopLink href={href} className={s.cardName}>
        {product.name}
      </ShopLink>
      <p className={s.cardPrice}>{product.price}</p>
      {product.availability !== 'In stock' && (
        <p className={soldOut ? s.stockOut : s.stockLow}>{product.availability}</p>
      )}
    </li>
  );
}
