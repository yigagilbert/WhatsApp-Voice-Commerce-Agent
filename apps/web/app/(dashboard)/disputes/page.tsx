import Link from 'next/link';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { describeEvent } from '@/lib/activity';
import { apiGet } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import type { DisputeDetail, DisputeRow } from '@/lib/types';
import { refreshDisputes } from './actions';
import { DisputeStatus, DisputesGrid } from './disputes-grid';

export const dynamic = 'force-dynamic';

function Detail({ d }: { d: DisputeDetail }) {
  const amount = d.amountMinor !== null && d.currency ? money(d.amountMinor, d.currency) : '—';
  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            PayPal dispute
          </p>
          <h2 className="text-xl font-semibold text-slate-900">{d.paypalDisputeId}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {d.reasonLabel} · {amount}
            {d.order
              ? ` · Order ${d.order.reference} (${d.order.customer})`
              : ' · Not matched to a Katale order'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DisputeStatus status={d.status} label={d.statusLabel} />
          <Link href="/disputes" className="text-sm text-slate-500 hover:underline">
            Close
          </Link>
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Opened</dt>
          <dd>{dateTime(d.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Response due</dt>
          <dd
            className={
              d.status === 'WAITING_FOR_SELLER_RESPONSE' ? 'font-medium text-rose-700' : ''
            }
          >
            {dateTime(d.sellerResponseDueAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Stage</dt>
          <dd>
            {d.lifecycleStage?.toLowerCase().replace(/_/g, ' ') ?? '—'}
            {d.outcome ? ` · ${d.outcome.toLowerCase().replace(/_/g, ' ')}` : ''}
          </dd>
        </div>
      </dl>
      {d.buyerMessage && (
        <blockquote className="mt-4 border-l-2 border-slate-300 pl-3 text-sm text-slate-700">
          <span className="block text-xs font-medium text-slate-500">Buyer says</span>“
          {d.buyerMessage}”
        </blockquote>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Evidence Katale holds</h3>
          <p className="text-xs text-slate-500">
            From Katale&apos;s own order, payment and shipment records — nothing generated.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {d.evidence.facts.map((f) => (
              <li key={f.label} className="flex gap-2">
                <span aria-hidden="true" className="text-emerald-600">
                  ✓
                </span>
                <span>
                  <span className="font-medium">{f.label}:</span> {f.value}
                </span>
              </li>
            ))}
          </ul>
          {d.evidence.missing.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold text-slate-700">Missing or weak</h3>
              <ul className="mt-2 space-y-1.5 text-sm text-amber-900">
                {d.evidence.missing.map((m) => (
                  <li key={m} className="flex gap-2">
                    <span aria-hidden="true">•</span>
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Responses</h3>
          {d.responses.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              None yet. Ask Katale AI on WhatsApp to &quot;review the dispute&quot;; it drafts a
              response and sends it only after you reply SUBMIT &lt;code&gt;.
            </p>
          ) : (
            <ul className="mt-2 space-y-3 text-sm">
              {d.responses.map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">
                    {r.status === 'SUBMITTED'
                      ? `Submitted ${dateTime(r.submittedAt)}`
                      : `${r.status.toLowerCase()} · ${dateTime(r.createdAt)}`}
                  </p>
                  <p className="mt-1 text-slate-800">“{r.responseText}”</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Evidence: {r.evidence.map((e) => e.label).join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-4 text-sm font-semibold text-slate-700">Timeline</h3>
          <ol className="mt-2 space-y-1 text-sm">
            {d.timeline.map((e) => {
              const ev = describeEvent(e);
              return (
                <li key={e.id} className="flex gap-3">
                  <time className="w-32 shrink-0 text-xs tabular-nums text-slate-500">
                    {dateTime(e.createdAt)}
                  </time>
                  <span className="text-slate-800">{ev.title}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; refresh?: string; refreshed?: string }>;
}) {
  const { d, refresh, refreshed } = await searchParams;
  const [list, detail] = await Promise.all([
    apiGet<{
      disputes: DisputeRow[];
      totals: { currency: string; count: number; amount: string }[];
    }>('/api/disputes?filter=all'),
    d ? apiGet<DisputeDetail>(`/api/disputes/${encodeURIComponent(d)}`) : Promise.resolve(null),
  ]);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Disputes"
          description="PayPal disputes, linked to the order, payment and shipment. Katale gathers evidence and drafts responses; nothing is sent to PayPal without your SUBMIT code."
        />
        <form action={refreshDisputes}>
          <button className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Refresh from PayPal
          </button>
        </form>
      </div>
      {refresh === 'failed' && (
        <ErrorNotice message="Couldn't refresh from PayPal just now. Showing the last saved data; please try again later." />
      )}
      {refreshed !== undefined && (
        <p role="status" className="mb-3 text-sm text-emerald-700">
          Refreshed from PayPal ({refreshed} dispute{refreshed === '1' ? '' : 's'} checked).
        </p>
      )}
      {!list.ok ? (
        <ErrorNotice message={list.error} />
      ) : (
        <DisputesGrid disputes={list.data.disputes} />
      )}
      {detail && !detail.ok && <ErrorNotice message={detail.error} />}
      {detail?.ok && <Detail d={detail.data} />}
    </>
  );
}
