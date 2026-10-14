import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { Order } from '@/lib/types';
import { OrdersGrid } from './orders-grid';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const result = await apiGet<Order[]>('/api/orders?limit=500');
  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order from WhatsApp text, WhatsApp voice notes and the Agent console. Totals are calculated by the backend, never by the AI. Click an order for details."
      />
      {result.ok ? <OrdersGrid orders={result.data} /> : <ErrorNotice message={result.error} />}
    </>
  );
}
