import Link from 'next/link';
import { ErrorNotice, PageHeader, Section } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ScheduleForm, SendNowButton, type Schedule } from './schedule-form';

export const dynamic = 'force-dynamic';

interface Run {
  id: string;
  periodKey: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  scheduledFor: string;
  status: 'SENDING' | 'SENT' | 'PARTIAL' | 'FAILED';
  text: string;
  createdAt: string;
  completedAt: string | null;
  deliveries: {
    status: 'PENDING' | 'SENT' | 'FAILED';
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
    operator: { name: string; phone: string | null };
  }[];
}

const TONE: Record<string, string> = {
  SENT: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  SENDING: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  PENDING: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  PARTIAL: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};
const Pill = ({ status }: { status: string }) => (
  <span
    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[status] ?? ''}`}
  >
    {status.charAt(0) + status.slice(1).toLowerCase()}
  </span>
);

export default async function ReportsPage() {
  const [schedule, runs] = await Promise.all([
    apiGet<Schedule>('/api/reports/schedule'),
    apiGet<Run[]>('/api/reports/runs'),
  ]);
  return (
    <>
      <PageHeader
        title="Reports"
        description="Proactive WhatsApp business reports for your admins (daily, weekly or monthly): sales, stock alerts, unpaid PayPal links, open disputes, a revenue chart and recommended actions."
      />
      {!schedule.ok ? (
        <ErrorNotice message={schedule.error} />
      ) : (
        <div className="max-w-3xl space-y-6">
          <Section title="Schedule">
            <p className="mb-3 text-sm text-slate-600">
              {schedule.data.enabled && schedule.data.nextAt
                ? `Next report: ${dateTime(schedule.data.nextAt)} (${schedule.data.timezone ?? schedule.data.merchantTimezone}).`
                : 'Scheduled reports are off.'}{' '}
              Sent to {schedule.data.recipients} admin{schedule.data.recipients === 1 ? '' : 's'} —{' '}
              <Link href="/admins" className="underline">
                manage admins
              </Link>
              .
            </p>
            <ScheduleForm schedule={schedule.data} />
          </Section>
          <Section title="Send now">
            <SendNowButton disabled={!schedule.data.recipients} />
          </Section>
          <Section title="Recent reports">
            {!runs.ok ? (
              <ErrorNotice message={runs.error} />
            ) : !runs.data.length ? (
              <p className="text-sm text-slate-600">No reports yet.</p>
            ) : (
              <ul className="space-y-3">
                {runs.data.map((run) => (
                  <li key={run.id} className="rounded-lg border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Pill status={run.status} />
                      <span className="font-medium text-slate-900">{dateTime(run.createdAt)}</span>
                      <span className="text-slate-500">
                        {run.trigger === 'MANUAL' ? 'Sent manually' : 'Scheduled'}
                      </span>
                    </div>
                    <ul className="mt-2 space-y-1 text-sm text-slate-700">
                      {run.deliveries.length ? (
                        run.deliveries.map((d, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-2">
                            <Pill status={d.status} />
                            <span>{d.operator.name}</span>
                            <span className="font-mono text-xs text-slate-500">
                              {d.operator.phone}
                            </span>
                            {d.status !== 'SENT' && d.lastError && (
                              <span className="text-xs text-rose-700">
                                {d.lastError} (attempt {d.attempts})
                              </span>
                            )}
                          </li>
                        ))
                      ) : (
                        <li className="text-xs text-slate-500">
                          No admin was set to receive reports.
                        </li>
                      )}
                    </ul>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-500">
                        Show message
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-800">
                        {run.text}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
