import type { PulseFigures, PulsePeriodFigures } from '@/lib/types';

const PERIOD_LABELS: Record<PulsePeriodFigures['period'], string> = {
  today: 'Today',
  this_week: 'This week',
  this_month: 'This month',
};

const COMPARISON: Record<PulsePeriodFigures['period'], string> = {
  today: 'vs yesterday so far',
  this_week: 'vs last week so far',
  this_month: 'vs last month so far',
};

function Change({ period }: { period: PulsePeriodFigures }) {
  const change = period.changePercent;
  if (change === null)
    return <span className="text-xs text-leaf-200">{`${period.previousNet} before`}</span>;
  const flat = change === 0;
  const up = change > 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-leaf-200">
      <span
        className={`rounded-full px-1.5 py-0.5 font-medium tabular-nums ${
          flat
            ? 'bg-white/10 text-white'
            : up
              ? 'bg-lime/20 text-lime'
              : 'bg-amber-300/15 text-amber-200'
        }`}
      >
        <span aria-hidden="true">{flat ? '→' : up ? '↑' : '↓'}</span>{' '}
        <span className="sr-only">{flat ? 'No change,' : up ? 'Up' : 'Down'}</span>
        {Math.abs(change)}%
      </span>
      {COMPARISON[period.period]}
    </span>
  );
}

/**
 * The headline figures, always visible and always from the backend. These sit outside AG Studio on
 * purpose: its value widgets can't compare against an earlier period, and period boundaries must
 * follow the merchant's timezone whatever the viewer's browser is set to.
 */
export function Pulse({
  figures,
  timezone,
}: {
  figures: PulseFigures | undefined;
  timezone: string;
}) {
  const stats = figures
    ? [
        { label: 'Net revenue', value: figures.net, hint: 'All time, after refunds' },
        { label: 'Gross sales', value: figures.gross, hint: `${figures.refunds} refunded` },
        {
          label: 'Completed orders',
          value: figures.paidOrders.toLocaleString('en-US'),
          hint: 'Paid, not fully refunded',
        },
        {
          label: 'Average order',
          value: figures.averageOrderValue ?? '—',
          hint: 'Per completed order',
        },
        {
          label: 'Outstanding',
          value: figures.outstanding,
          hint: `${figures.outstandingOrders} awaiting PayPal payment`,
        },
      ]
    : [];

  return (
    <section aria-label="Business performance" className="flex min-w-0 flex-col gap-3">
      <div className="relative flex flex-1 flex-col overflow-hidden rounded-2xl bg-leaf-900 p-5 text-white shadow-sm sm:p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-leaf-600/40 blur-3xl"
        />
        <div className="relative flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-leaf-200">
            Net revenue
          </h2>
          <p className="text-[11px] text-leaf-200">{timezone}</p>
        </div>
        {figures ? (
          <dl className="relative my-auto grid gap-5 pt-4 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-white/10">
            {figures.periods.map((period) => (
              <div key={period.period} className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
                <dt className="text-sm text-leaf-100">{PERIOD_LABELS[period.period]}</dt>
                <dd className="mt-1 truncate font-display text-3xl font-semibold tabular-nums tracking-tight lg:text-4xl">
                  {period.net}
                </dd>
                <dd className="mt-1.5 text-xs text-leaf-100 tabular-nums">
                  {period.paidOrders} {period.paidOrders === 1 ? 'order' : 'orders'}
                </dd>
                <dd className="mt-2">
                  <Change period={period} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="relative mt-4 text-sm text-leaf-100">
            Your sales will appear here as soon as a customer pays with PayPal.
          </p>
        )}
      </div>

      {figures && (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-mist bg-mist sm:grid-cols-3 xl:grid-cols-5">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={`bg-white p-4 ${index === 0 ? 'col-span-2 sm:col-span-1' : ''}`}
            >
              <dt className="text-xs text-slate-500">{stat.label}</dt>
              <dd className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight text-charcoal">
                {stat.value}
              </dd>
              <dd className="mt-0.5 truncate text-xs text-slate-500" title={stat.hint}>
                {stat.hint}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
