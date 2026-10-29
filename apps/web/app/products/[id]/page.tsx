import Link from 'next/link';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import type { ProductDetail } from '@/lib/types';
import { ProductEditor } from '../product-editor';

export const dynamic = 'force-dynamic';

const SAVED: Record<string, { ok: boolean; text: string }> = {
  created: { ok: true, text: 'Product added. Customers can find it on WhatsApp.' },
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
  const notice = saved ? SAVED[saved] : undefined;
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
