import Link from 'next/link';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import { siteUrl } from '@/lib/public-site';
import type { ProductDetail, StorefrontSettings } from '@/lib/types';
import { ProductEditor } from '../product-editor';

export const dynamic = 'force-dynamic';

const SAVED: Record<string, { ok: boolean; text: string }> = {
  created: { ok: true, text: 'Product added. Customers can find it on WhatsApp.' },
  'created-hidden': {
    ok: true,
    text: 'Product added. It stays hidden from customers until you turn on "Show to customers".',
  },
  'photo-failed': {
    ok: false,
    text: 'Product added, but the photo could not be saved. Choose it again below.',
  },
};

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const result = await apiGet<ProductDetail>(`/api/products/${encodeURIComponent(id)}`);
  if (!result.ok) return <ErrorNotice message={result.error} />;
  const product = result.data;
  const notice = saved
    ? SAVED[saved === 'created' && !product.visibleToCustomers ? 'created-hidden' : saved]
    : undefined;
  const storefront = await apiGet<StorefrontSettings>('/api/storefront');
  const publicLink =
    storefront.ok && storefront.data.enabled && product.active && product.visibleToCustomers
      ? `${await siteUrl()}/shop/${storefront.data.slug}/p/${product.id}`
      : null;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/products" className="text-slate-500 hover:underline">
          ← Products
        </Link>
      </p>
      <PageHeader
        title={product.name}
        description={`${money(product.unitPriceMinor, product.currency)} · ${
          product.stockQuantity == null ? 'stock not tracked' : `${product.stockQuantity} in stock`
        }${product.active ? '' : ' · inactive'}. Customers only see In stock / Low stock / Out of stock.`}
      />
      {publicLink && (
        <p className="mb-4 flex max-w-3xl flex-wrap items-center gap-3 text-sm text-slate-600">
          <a href={publicLink} target="_blank" rel="noreferrer" className="font-medium underline">
            View on your storefront
          </a>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${product.name}: ${publicLink}`)}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            Share on WhatsApp
          </a>
        </p>
      )}
      {notice && (
        <p
          role="status"
          className={`mb-4 max-w-3xl rounded-md px-3 py-2 text-sm ${notice.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}
        >
          {notice.text}
        </p>
      )}
      <div className="max-w-3xl">
        <ProductEditor key={product.id} product={product} currency={product.currency} />
      </div>
    </>
  );
}
