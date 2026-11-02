'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import { StatusPill } from '@/components/ui-client';
import type { Payment } from '@/lib/types';
import { refreshPayment, sendReminder } from './actions';
import { toMajorNumber } from '@vca/commerce/money';

/** Same limits as the API: one reminder per 24 h, three per payment link. */
const MAX_REMINDERS = 3;

type Notice = { ok: boolean; text: string } | null;
type OnNotice = (notice: Notice) => void;

function RemindButton({ row, onNotice }: { row: PaymentRow; onNotice: OnNotice }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const recent =
    row.lastReminderAt !== null && Date.now() - row.lastReminderAt.getTime() < 24 * 3_600_000;
  const disabled = pending || recent || row.reminderCount >= MAX_REMINDERS;
  return (
    <button
      type="button"
      disabled={disabled}
      title={
        row.reminderCount >= MAX_REMINDERS
          ? 'All reminders used'
          : recent
            ? 'Reminded in the last 24 hours'
            : `Send ${row.customer} a WhatsApp reminder with the PayPal link`
      }
      onClick={() => {
        if (
          !window.confirm(
            `Send ${row.customer} a WhatsApp payment reminder for ${row.reference}? (${row.reminderCount} of ${MAX_REMINDERS} sent so far)`,
          )
        )
          return;
        start(async () => {
          const result = await sendReminder(row.id);
          onNotice({ ok: result.ok, text: result.message });
          router.refresh();
        });
      }}
      className="rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
    >
      {pending ? 'Sending…' : row.reminderCount ? `Remind (${row.reminderCount})` : 'Remind'}
    </button>
  );
}

/** Payment review: re-check the payment and its refunds with PayPal. */
function RefreshButton({ row, onNotice }: { row: PaymentRow; onNotice: OnNotice }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title="Check this payment and its refunds with PayPal"
      aria-label={`Check ${row.reference} with PayPal`}
      onClick={() =>
        start(async () => {
          const result = await refreshPayment(row.id);
          onNotice({ ok: result.ok, text: `${row.reference}: ${result.message}` });
          router.refresh();
        })
      }
      className="rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
    >
      {pending ? 'Checking…' : 'Check'}
    </button>
  );
}

interface PaymentRow {
  id: string;
  reference: string;
  customer: string;
  amount: number;
  amountMinor: number;
  currency: string;
  provider: string;
  providerStatus: string;
  status: Payment['status'];
  createdAt: Date;
  completedAt: Date | null;
  checkoutUrl: string | null;
  trace: string | null;
  reminderCount: number;
  lastReminderAt: Date | null;
  refundedMinor: number;
}

type Pinned = { node: { rowPinned?: string | null } };

export function PaymentsGrid({ payments }: { payments: Payment[] }) {
  const [notice, setNotice] = useState<Notice>(null);
  const rows = useMemo<PaymentRow[]>(
    () =>
      payments.map((p) => ({
        id: p.id,
        reference: p.order.reference,
        customer: p.order.customer?.name ?? '',
        amount: toMajorNumber(p.amountMinor, p.currency),
        amountMinor: p.amountMinor,
        currency: p.currency,
        provider: p.provider === 'PAYPAL' ? 'PayPal' : p.provider,
        providerStatus: (p.providerStatus ?? '').toLowerCase().replace(/_/g, ' '),
        status: p.status,
        createdAt: new Date(p.createdAt),
        completedAt: p.completedAt ? new Date(p.completedAt) : null,
        checkoutUrl: p.checkoutUrl,
        trace: p.correlationId,
        reminderCount: p.reminderCount ?? 0,
        lastReminderAt: p.lastReminderAt ? new Date(p.lastReminderAt) : null,
        refundedMinor: p.refundedMinor ?? 0,
      })),
    [payments],
  );

  const columns = useMemo<ColDef<PaymentRow>[]>(
    () => [
      {
        field: 'reference',
        headerName: 'Order',
        pinned: 'left',
        minWidth: 120,
        cellClass: 'font-medium',
      },
      { field: 'customer', headerName: 'Customer', minWidth: 150 },
      {
        field: 'amount',
        headerName: 'Amount',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueFormatter: (p) => formatMinor(p.data?.amountMinor, p.data?.currency),
        cellClass: 'tabular-nums font-medium',
      },
      {
        field: 'refundedMinor',
        headerName: 'Refunded',
        type: 'rightAligned',
        minWidth: 110,
        valueFormatter: (p) =>
          p.node?.rowPinned || !p.value ? '' : formatMinor(p.value, p.data?.currency),
        cellClass: 'tabular-nums text-rose-700',
      },
      { field: 'currency', headerName: 'Currency', minWidth: 80, maxWidth: 100 },
      { field: 'provider', headerName: 'Provider', minWidth: 100 },
      {
        field: 'status',
        headerName: 'Status',
        minWidth: 140,
        cellRenderer: (p: { value?: string; data?: PaymentRow } & Pinned) =>
          p.value && !p.node.rowPinned ? (
            <StatusPill
              status={
                p.value === 'COMPLETED' && (p.data?.refundedMinor ?? 0) > 0
                  ? 'PARTIALLY_REFUNDED'
                  : p.value
              }
              kind="payment"
            />
          ) : null,
      },
      { field: 'providerStatus', headerName: 'PayPal status', minWidth: 160 },
      {
        field: 'createdAt',
        headerName: 'Requested',
        filter: 'agDateColumnFilter',
        sort: 'desc',
        minWidth: 170,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : formatDate(p.value)),
      },
      {
        field: 'completedAt',
        headerName: 'Completed',
        filter: 'agDateColumnFilter',
        minWidth: 170,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : formatDate(p.value)),
      },
      {
        field: 'trace',
        headerName: 'Trace',
        minWidth: 100,
        sortable: false,
        filter: false,
        cellRenderer: (p: { value?: string | null } & Pinned) =>
          p.value && !p.node.rowPinned ? (
            <Link
              className="text-sky-700 hover:underline"
              href={`/activity?trace=${encodeURIComponent(p.value)}`}
            >
              View
            </Link>
          ) : null,
      },
      {
        field: 'checkoutUrl',
        headerName: 'Link',
        minWidth: 90,
        sortable: false,
        filter: false,
        cellRenderer: (p: { value?: string | null; data?: PaymentRow } & Pinned) =>
          p.value && !p.node.rowPinned && p.data?.status !== 'COMPLETED' ? (
            <a
              className="text-sky-700 hover:underline"
              href={p.value}
              target="_blank"
              rel="noreferrer"
            >
              Open
            </a>
          ) : null,
      },
      {
        colId: 'remind',
        headerName: 'Reminder',
        minWidth: 120,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: PaymentRow } & Pinned) =>
          p.data &&
          !p.node.rowPinned &&
          (p.data.status === 'CREATED' || p.data.status === 'APPROVED') ? (
            <RemindButton row={p.data} onNotice={setNotice} />
          ) : null,
      },
      {
        colId: 'check',
        headerName: 'PayPal',
        minWidth: 110,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: PaymentRow } & Pinned) =>
          p.data &&
          !p.node.rowPinned &&
          p.data.status !== 'FAILED' &&
          p.data.status !== 'CANCELLED' ? (
            <RefreshButton row={p.data} onNotice={setNotice} />
          ) : null,
      },
    ],
    [],
  );

  return (
    <>
      {notice && (
        <p
          role="status"
          className={`mb-3 rounded-md px-3 py-2 text-sm ${notice.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}
        >
          {notice.text}
        </p>
      )}
      <CommerceGrid<PaymentRow>
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        statusField="status"
        statusOptions={[
          { label: 'Completed', value: 'COMPLETED' },
          { label: 'Awaiting buyer', value: 'CREATED' },
          { label: 'Approved', value: 'APPROVED' },
          { label: 'Failed', value: 'FAILED' },
          { label: 'Refunded', value: 'REFUNDED' },
          { label: 'Cancelled', value: 'CANCELLED' },
        ]}
        summarize={(visible) => {
          // Money received: completed payments, net of refunds (not open, failed or cancelled links).
          const received = visible.filter((r) => r.status === 'COMPLETED');
          const currencies = [...new Set(received.map((r) => r.currency))];
          const one = currencies.length === 1 ? currencies[0]! : '';
          return {
            reference: `${visible.length} payments`,
            customer: received.length ? `${received.length} received (net)` : '',
            amountMinor: one
              ? received.reduce((sum, r) => sum + r.amountMinor - r.refundedMinor, 0)
              : undefined,
            currency: one,
          } as Partial<PaymentRow>;
        }}
        exportName="katale-payments"
        searchPlaceholder="Search payments…"
        emptyMessage="No payment requests yet. They appear after the merchant types CONFIRM."
      />
    </>
  );
}
