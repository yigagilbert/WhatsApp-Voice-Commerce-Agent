import Link from 'next/link';
import { ErrorNotice, PageHeader, Section, StatCard, StatusBadge } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { amounts, dateTime, money } from '@/lib/format';
import { buildInsights } from '@/lib/insights';
import type { DashboardSummary } from '@/lib/types';
import { GettingStarted } from './getting-started';

export const dynamic = 'force-dynamic';

/** Horizontal bar list (share of the largest value). Values are pre-formatted by the API. */
function Bars({
  rows,
}: {
  rows: { key: string; label: string; detail: string; value: string; amountMinor: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.amountMinor));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium text-slate-800">{r.label}</span>
            <span className="tabular-nums text-slate-900">{r.value}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-slate-100">
              <div
                className="h-1.5 rounded-full bg-slate-800"
                style={{ width: `${Math.max(2, (r.amountMinor / max) * 100)}%` }}
              />
            </div>
            <span className="w-28 shrink-0 text-right text-xs text-slate-500">{r.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Panel({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty?: string;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-4 text-sm font-semibold text-slate-700">{title}</h2>
      {empty ? <p className="text-sm text-slate-500">{empty}</p> : children}
    </section>
  );
}

export default async function OverviewPage() {
  const result = await apiGet<DashboardSummary>('/api/dashboard/summary');
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorNotice message={result.error} />
      </>
    );
  }
  const s = result.data;
  const insights = buildInsights(s);
  const noSales = s.counts.paidOrders === 0;

  return (
    <>
      <PageHeader
        title={s.merchant.businessName}
        description={`Revenue counts completed PayPal payments only · ${s.merchant.timezone}`}
      />

      <GettingStarted summary={s} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Revenue"
          value={amounts(s.revenue)}
          hint={`${amounts(s.revenueThisWeek)} this week`}
        />
        <StatCard
          label="Paid orders"
          value={s.counts.paidOrders}
          hint={`of ${s.counts.orders} orders`}
        />
        <StatCard
          label="Awaiting payment"
          value={s.counts.awaitingPayment}
          hint="Payment link sent"
        />
        <StatCard label="Outstanding" value={amounts(s.outstanding)} hint="Not yet paid" />
        <StatCard
          label="Customers"
          value={s.counts.customers}
          hint={`${s.counts.products} products`}
        />
        <StatCard
          label="Average order"
          value={amounts(s.averageOrderValue)}
          hint="Per paid order"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/orders" className="block">
          <StatCard
            label="To ship"
            value={s.operations.awaitingShipment}
            hint="Paid, no tracking yet"
          />
        </Link>
        <StatCard label="Shipped" value={s.operations.shipped} hint="Tracking added at PayPal" />
        <Link href="/disputes" className="block">
          <StatCard
            label="Open disputes"
            value={s.operations.openDisputes}
            hint={
              s.operations.needsResponse
                ? `${s.operations.needsResponse} need${s.operations.needsResponse === 1 ? 's' : ''} your response`
                : 'None need a response'
            }
          />
        </Link>
        <StatCard
          label="Disputed amount"
          value={amounts(s.operations.disputedAmount)}
          hint="Open disputes"
        />
      </div>

      {insights.length > 0 && (
        <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-700">Highlights</h2>
            <p className="text-xs text-slate-500">
              Calculated from your payments — no AI estimates
            </p>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
            {insights.map((line) => (
              <li key={line} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400"
                />
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Panel title="Sales by source" empty={noSales ? 'No paid orders yet.' : undefined}>
          <Bars
            rows={s.bySource.map((x) => ({
              key: `${x.currency}-${x.name}`,
              label: x.name,
              detail: `${x.orders} paid order${x.orders === 1 ? '' : 's'}`,
              value: x.formatted,
              amountMinor: x.amountMinor,
            }))}
          />
        </Panel>
        <Panel title="Top products" empty={noSales ? 'No paid orders yet.' : undefined}>
          <Bars
            rows={s.topProducts.map((p) => ({
              key: `${p.currency}-${p.name}`,
              label: p.name,
              detail: `${p.quantity} sold · ${p.sharePercent}%`,
              value: p.formatted,
              amountMinor: p.amountMinor,
            }))}
          />
        </Panel>
        <Panel title="Top customers" empty={noSales ? 'No paid orders yet.' : undefined}>
          <Bars
            rows={s.topCustomers.map((c) => ({
              key: `${c.currency}-${c.name}`,
              label: c.name,
              detail: `${c.orders} paid order${c.orders === 1 ? '' : 's'}`,
              value: c.formatted,
              amountMinor: c.amountMinor,
            }))}
          />
        </Panel>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section
          title="Recent orders"
          action={
            <Link href="/orders" className="text-xs font-medium text-slate-600 hover:underline">
              All orders →
            </Link>
          }
        >
          {s.recentOrders.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No orders yet. Send Katale AI an order on WhatsApp or in the Agent console.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
              {s.recentOrders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      {o.reference}
                      {o.inputMode === 'VOICE' && (
                        <span className="ml-2 text-xs font-normal text-indigo-700">voice</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {o.customer.name} · {dateTime(o.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums">{money(o.totalMinor, o.currency)}</span>
                    <StatusBadge status={o.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Recent payments"
          action={
            <Link href="/payments" className="text-xs font-medium text-slate-600 hover:underline">
              All payments →
            </Link>
          }
        >
          {s.recentPayments.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No payment requests yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
              {s.recentPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{p.order.reference}</p>
                    <p className="truncate text-xs text-slate-500">
                      {p.order.customer?.name ?? ''} · {dateTime(p.completedAt ?? p.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums">{money(p.amountMinor, p.currency)}</span>
                    <StatusBadge status={p.status} kind="payment" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
