import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { Payment } from '@/lib/types';
import { PaymentsGrid } from './payments-grid';

export const dynamic = 'force-dynamic';

export default async function PaymentsPage() {
  const result = await apiGet<Payment[]>('/api/payments?limit=500');
  return (
    <>
      <PageHeader
        title="Payments"
        description="PayPal payment requests. Status comes only from PayPal: the buyer's return and verified webhooks."
      />
      {result.ok ? <PaymentsGrid payments={result.data} /> : <ErrorNotice message={result.error} />}
    </>
  );
}
