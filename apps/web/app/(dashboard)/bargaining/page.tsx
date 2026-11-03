import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { ErrorNotice, PageHeader, Section, StatCard, StatusBadge } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import type { PricingOverview } from '@/lib/types';
import { BundleForm } from './bundle-form';

export const dynamic = 'force-dynamic';

const LABEL = { LIST: '', QUANTITY: 'bulk', BUNDLE: 'bundle', NEGOTIATED: 'agreed' } as const;

type Row = PricingOverview['orders'][number];

export default async function BargainingPage() {
  const result = await apiGet<PricingOverview>('/api/pricing');
  if (!result.ok) return <ErrorNotice message={result.error} />;
  const data = result.data;
  const m = (minor: number) => money(minor, data.currency);
  const stats = data.last30Days;
  const rate = stats.offersMade ? Math.round((stats.dealsAgreed / stats.offersMade) * 100) : null;

  return (
    <>
      <PageHeader
        title="Bargaining"
        description="Customers can ask for a better price on WhatsApp, like at the market. Katale AI negotiates within the lowest price you set per product, and every price is checked by Katale before an order or PayPal link is made."
      />
      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Open to offers"
            value={`${data.products.bargaining} of ${data.products.active}`}
            hint={`${data.products.quantityDeals} with quantity discounts`}
          />
          <StatCard
            label="Offers made (30 days)"
            value={stats.offersMade}
            hint={rate === null ? 'No bargaining yet' : `${stats.dealsAgreed} agreed · ${rate}%`}
          />
          <StatCard
            label="Discounted sales (30 days)"
            value={m(stats.revenueMinor)}
            hint={`${stats.paidDiscountedOrders} paid orders · ${stats.paidNegotiatedOrders} bargained`}
          />
          <StatCard
            label="Discounts given (30 days)"
            value={m(stats.discountMinor)}
            hint="Against regular prices, paid orders"
          />
        </div>

        {data.products.bargaining === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No product is open to bargaining yet. Open a product in{' '}
            <Link href="/products" className="font-medium text-slate-900 underline">
              Products
            </Link>
            , tick <em>Customers can bargain on WhatsApp</em> and set the lowest price you accept.
          </p>
        )}

        <Section title="Bundle discount">
          <BundleForm bundle={data.bundle} />
        </Section>

        <Section title="Orders with discounts">
          <DataTable<Row>
            rowData={data.orders}
            emptyMessage="No discounted orders yet. Agreed prices, bulk and bundle discounts appear here once customers order."
            columnDefs={[
              {
                field: 'reference',
                headerName: 'Order',
                cellRenderer: (r) => (
                  <span className="font-medium">
                    {r.reference}
                    {r.negotiated && (
                      <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                        bargained
                      </span>
                    )}
                  </span>
                ),
              },
              { field: 'customer', headerName: 'Customer' },
              {
                field: 'items',
                headerName: 'Items (regular → sold)',
                cellRenderer: (r) => (
                  <ul className="space-y-0.5 text-xs">
                    {r.items.map((i, n) => (
                      <li key={n}>
                        {i.description} × {i.quantity}:{' '}
                        {i.listUnitPriceMinor !== null ? (
                          <>
                            <s className="text-slate-400">
                              {money(i.listUnitPriceMinor, r.currency)}
                            </s>{' '}
                            <span className="font-medium">
                              {money(i.unitPriceMinor, r.currency)}
                            </span>{' '}
                            <span className="text-slate-500">{LABEL[i.pricing]}</span>
                          </>
                        ) : (
                          money(i.unitPriceMinor, r.currency)
                        )}
                      </li>
                    ))}
                  </ul>
                ),
              },
              {
                field: 'totalMinor',
                headerName: 'Total',
                align: 'right',
                valueFormatter: (r) => money(r.totalMinor, r.currency),
              },
              {
                field: 'discountMinor',
                headerName: 'Discount',
                align: 'right',
                valueFormatter: (r) => `−${money(r.discountMinor, r.currency)}`,
              },
              {
                field: 'status',
                headerName: 'Status',
                cellRenderer: (r) => <StatusBadge status={r.status} />,
              },
              {
                field: 'createdAt',
                headerName: 'Date',
                valueFormatter: (r) => dateTime(r.createdAt),
              },
            ]}
          />
        </Section>
      </div>
    </>
  );
}
