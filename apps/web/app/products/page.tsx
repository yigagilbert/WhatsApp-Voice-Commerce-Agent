import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { ProductStat } from '@/lib/types';
import { ProductsGrid } from './products-grid';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const result = await apiGet<ProductStat[]>('/api/products/stats');
  return (
    <>
      <PageHeader
        title="Products"
        description="The catalog Katale AI prices orders from. Units sold and revenue count paid orders only (excluding shipping)."
      />
      {result.ok ? <ProductsGrid products={result.data} /> : <ErrorNotice message={result.error} />}
    </>
  );
}
