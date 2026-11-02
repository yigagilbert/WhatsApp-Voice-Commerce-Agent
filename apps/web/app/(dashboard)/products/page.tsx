import Link from 'next/link';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { ProductStat } from '@/lib/types';
import { ProductsGrid } from './products-grid';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const result = await apiGet<ProductStat[]>('/api/products/stats');
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Products"
          description="Your catalog: what customers see on WhatsApp and what Katale AI prices orders from. Click a product to edit it, change stock or add a photo."
        />
        <Link
          href="/products/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add product
        </Link>
      </div>
      {result.ok ? <ProductsGrid products={result.data} /> : <ErrorNotice message={result.error} />}
    </>
  );
}
