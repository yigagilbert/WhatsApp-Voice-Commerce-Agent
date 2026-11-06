import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { CustomerStat } from '@/lib/types';
import { CustomersGrid } from './customers-grid';

export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const result = await apiGet<CustomerStat[]>('/api/customers/stats');
  return (
    <>
      <PageHeader
        title="Customers"
        description="Revenue counts completed PayPal payments only. Click a customer to see their orders."
      />
      {result.ok ? (
        <CustomersGrid key={q} customers={result.data} initialSearch={q} />
      ) : (
        <ErrorNotice message={result.error} />
      )}
    </>
  );
}
