import Link from 'next/link';
import { productImage, shopHref, type PublicProduct } from '@/lib/storefront-types';
import { AddButton } from './add-button';
import s from '../shop.module.css';

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
  if (!product.imageVersion)
    return (
      <span className={s.noPhoto} aria-hidden="true">
        {product.name.slice(0, 1)}
      </span>
    );
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
  return (
    <li className={s.card}>
      <div className={`${s.cardPhoto} ${soldOut ? s.cardPhotoOut : ''}`}>
        <Link href={shopHref(slug, preview, `/p/${product.id}`)} tabIndex={-1} aria-hidden="true">
          <ProductPhoto
            slug={slug}
            product={product}
            preview={preview}
            eager={eager ?? false}
            sizes="(min-width: 1100px) 270px, (min-width: 700px) 32vw, 50vw"
          />
        </Link>
        {!soldOut && !preview && <AddButton productId={product.id} name={product.name} />}
      </div>
      <Link href={shopHref(slug, preview, `/p/${product.id}`)} className={s.cardName}>
        {product.name}
      </Link>
      <p className={s.cardPrice}>{product.price}</p>
      {product.availability !== 'In stock' && (
        <p className={soldOut ? s.stockOut : s.stockLow}>{product.availability}</p>
      )}
    </li>
  );
}
