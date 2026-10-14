import Link from 'next/link';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { describeEvent, type Stage } from '@/lib/activity';
import { apiGet } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AuditEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STAGE_STYLES: Record<Stage, string> = {
  Input: 'bg-slate-100 text-slate-700',
  'AI interprets': 'bg-violet-50 text-violet-700',
  'Backend verifies': 'bg-sky-50 text-sky-700',
  'Merchant approves': 'bg-amber-50 text-amber-800',
  'PayPal executes': 'bg-emerald-50 text-emerald-700',
  Notified: 'bg-teal-50 text-teal-700',
  Dispute: 'bg-orange-50 text-orange-800',
  Problem: 'bg-rose-50 text-rose-700',
};

const PRINCIPLES: [Stage, string][] = [
  ['AI interprets', 'natural language → structured request'],
  ['Backend verifies', 'customer, product, price, totals, limits'],
  ['Merchant approves', 'typed CONFIRM code'],
  ['PayPal executes', 'checkout, capture, verified webhooks'],
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ trace?: string }>;
}) {
  const { trace } = await searchParams;
  const query = new URLSearchParams({ limit: '150', ...(trace ? { correlationId: trace } : {}) });
  const result = await apiGet<AuditEvent[]>(`/api/dashboard/activity?${query}`);
  // A single transaction reads best as a story (oldest first); the full log newest first.
  const events = result.ok ? (trace ? [...result.data].reverse() : result.data) : [];

  return (
    <>
      <PageHeader
        title={trace ? 'Transaction trace' : 'Activity'}
        description={
          trace
            ? 'Every step of one transaction, from the merchant’s message to the payment notification.'
            : 'An audit trail of what the AI decided, what the backend verified, what the merchant approved and what PayPal executed.'
        }
      />

      <ol className="mb-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {PRINCIPLES.map(([stage, text], i) => (
          <li key={stage} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[stage]}`}
            >
              {i + 1}. {stage}
            </span>
            <p className="mt-1 text-xs text-slate-500">{text}</p>
          </li>
        ))}
      </ol>

      {trace && (
        <Link href="/activity" className="mb-4 inline-block text-sm text-sky-700 hover:underline">
          ← All activity
        </Link>
      )}
      {!result.ok ? (
        <ErrorNotice message={result.error} />
      ) : events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No activity yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {events.map((e) => {
            const d = describeEvent(e);
            return (
              <li
                key={e.id}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <time className="w-36 shrink-0 text-xs tabular-nums text-slate-500 sm:pt-0.5">
                  {dateTime(e.createdAt)}
                </time>
                <span
                  className={`inline-flex w-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium sm:w-36 sm:justify-center ${STAGE_STYLES[d.stage]}`}
                >
                  {d.stage}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-900">{d.title}</p>
                  {d.detail && <p className="mt-0.5 truncate text-xs text-slate-500">{d.detail}</p>}
                </div>
                {!trace && e.correlationId && (
                  <Link
                    href={`/activity?trace=${encodeURIComponent(e.correlationId)}`}
                    className="shrink-0 text-xs text-slate-500 hover:text-sky-700 hover:underline"
                    title={`Trace ${e.correlationId}`}
                  >
                    View trace
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
