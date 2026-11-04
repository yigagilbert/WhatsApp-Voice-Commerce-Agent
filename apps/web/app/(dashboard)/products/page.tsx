import Link from 'next/link';
import { FilteredView } from '@/components/filtered-view';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { ProductStat } from '@/lib/types';
import { ProductsGrid } from './products-grid';

export const dynamic = 'force-dynamic';

/** Views the Overview's "needs attention" list links to. */
const VIEWS: Record<string, { label: string; matches: (product: ProductStat) => boolean }> = {
  'out-of-stock': {
    label: 'out of stock',
    matches: (p) => p.active && p.stockQuantity !== null && p.stockQuantity <= 0,
  },
  'low-stock': {
    label: 'at or below the reorder level',
    matches: (p) =>
      p.active &&
      p.stockQuantity !== null &&
      p.stockQuantity > 0 &&
      p.reorderLevel != null &&
      p.stockQuantity <= p.reorderLevel,
  },
};

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const filter = view ? VIEWS[view] : undefined;
  const result = await apiGet<ProductStat[]>('/api/products/stats');
  const products =
    result.ok && filter ? result.data.filter(filter.matches) : result.ok ? result.data : [];
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
      {filter && result.ok && (
        <FilteredView label={filter.label} count={products.length} clearHref="/products" />
      )}
      {result.ok ? <ProductsGrid products={products} /> : <ErrorNotice message={result.error} />}
    </>
  );
}
