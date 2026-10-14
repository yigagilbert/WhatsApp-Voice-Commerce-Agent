import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { CustomerStat } from '@/lib/types';
import { CustomersGrid } from './customers-grid';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const result = await apiGet<CustomerStat[]>('/api/customers/stats');
  return (
    <>
      <PageHeader title="Customers" description="Revenue counts completed PayPal payments only." />
      {result.ok ? (
        <CustomersGrid customers={result.data} />
      ) : (
        <ErrorNotice message={result.error} />
      )}
    </>
  );
}
