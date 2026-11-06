import { FilteredView } from '@/components/filtered-view';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { Order } from '@/lib/types';
import { OrdersGrid } from './orders-grid';

export const dynamic = 'force-dynamic';

const WEEK_MS = 7 * 86_400_000;

/** Views the Overview's "needs attention" list links to. */
const VIEWS: Record<string, { label: string; matches: (order: Order) => boolean }> = {
  'to-ship': {
    label: 'paid and not shipped',
    matches: (o) => o.status === 'PAID' && o.fulfillmentStatus === 'NOT_SHIPPED',
  },
  'awaiting-payment': {
    label: 'awaiting PayPal payment',
    matches: (o) => o.status === 'AWAITING_PAYMENT',
  },
  'to-approve': {
    label: 'customer orders to approve',
    matches: (o) => o.status === 'DRAFT' && o.placedBy === 'CUSTOMER',
  },
  review: { label: 'orders that need review', matches: (o) => !!o.attention },
  expired: {
    label: 'payment links that expired this week',
    matches: (o) =>
      o.cancelReason === 'PAYMENT_EXPIRED' &&
      !!o.cancelledAt &&
      Date.now() - new Date(o.cancelledAt).getTime() <= WEEK_MS,
  },
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const { view, q } = await searchParams;
  const filter = view ? VIEWS[view] : undefined;
  const result = await apiGet<Order[]>('/api/orders?limit=500');
  const orders =
    result.ok && filter ? result.data.filter(filter.matches) : result.ok ? result.data : [];
  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order from WhatsApp text, WhatsApp voice notes and the Agent console. Totals are calculated by the backend, never by the AI. Click an order for details."
      />
      {filter && result.ok && (
        <FilteredView label={filter.label} count={orders.length} clearHref="/orders" />
      )}
      {result.ok ? (
        <OrdersGrid key={q} orders={orders} filteredView={filter?.label} initialSearch={q} />
      ) : (
        <ErrorNotice message={result.error} />
      )}
    </>
  );
}
