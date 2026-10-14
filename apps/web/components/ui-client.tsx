'use client';

import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@vca/commerce/labels';

const TONES: Record<string, string> = {
  PAID: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  AWAITING_PAYMENT: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  CREATED: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  APPROVED: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  DRAFT: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  CANCELLED: 'bg-slate-100 text-slate-500 ring-slate-500/20',
  REFUNDED: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};

/** Order or payment status as a readable badge ("Awaiting payment", "Awaiting buyer"). */
export function StatusPill({
  status,
  kind = 'order',
}: {
  status: string;
  kind?: 'order' | 'payment';
}) {
  const labels: Record<string, string> =
    kind === 'payment' ? PAYMENT_STATUS_LABELS : ORDER_STATUS_LABELS;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-5 ring-1 ring-inset ${TONES[status] ?? TONES.DRAFT}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

/** "🎙 Voice" / "Text" marker for how the merchant asked. */
export function InputModePill({ mode }: { mode: 'TEXT' | 'VOICE' }) {
  return mode === 'VOICE' ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium leading-5 text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Z" />
        <path d="M4 7.5a.75.75 0 0 0-1.5 0 5.5 5.5 0 0 0 4.75 5.45V14.5a.75.75 0 0 0 1.5 0v-1.55A5.5 5.5 0 0 0 13.5 7.5a.75.75 0 0 0-1.5 0 4 4 0 0 1-8 0Z" />
      </svg>
      Voice
    </span>
  ) : (
    <span className="inline-flex rounded-full bg-white px-2 py-0.5 text-xs font-medium leading-5 text-slate-600 ring-1 ring-inset ring-slate-200">
      Text
    </span>
  );
}
