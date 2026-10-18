'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useTransition } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import { StatusPill } from '@/components/ui-client';
import type { Payment } from '@/lib/types';
import { sendReminder } from './actions';

/** Same limits as the API: one reminder per 24 h, three per payment link. */
const MAX_REMINDERS = 3;

function RemindButton({ row }: { row: PaymentRow }) {
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
          window.alert(result.message);
          router.refresh();
        });
      }}
      className="rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
    >
      {pending ? 'Sending…' : row.reminderCount ? `Remind (${row.reminderCount})` : 'Remind'}
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
}

type Pinned = { node: { rowPinned?: string | null } };

export function PaymentsGrid({ payments }: { payments: Payment[] }) {
  const rows = useMemo<PaymentRow[]>(
    () =>
      payments.map((p) => ({
        id: p.id,
        reference: p.order.reference,
        customer: p.order.customer?.name ?? '',
        amount: p.amountMinor / 100,
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
      { field: 'currency', headerName: 'Currency', minWidth: 80, maxWidth: 100 },
      { field: 'provider', headerName: 'Provider', minWidth: 100 },
      {
        field: 'status',
        headerName: 'Status',
        minWidth: 140,
        cellRenderer: (p: { value?: string } & Pinned) =>
          p.value && !p.node.rowPinned ? <StatusPill status={p.value} kind="payment" /> : null,
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
            <RemindButton row={p.data} />
          ) : null,
      },
    ],
    [],
  );

  return (
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
      ]}
      summarize={(visible) => {
        const currencies = [...new Set(visible.map((r) => r.currency))];
        const one = currencies.length === 1 ? currencies[0]! : '';
        return {
          reference: `${visible.length} payments`,
          amountMinor: one ? visible.reduce((sum, r) => sum + r.amountMinor, 0) : undefined,
          currency: one,
        } as Partial<PaymentRow>;
      }}
      exportName="katale-payments"
      searchPlaceholder="Search payments…"
      emptyMessage="No payment requests yet. They appear after the merchant types CONFIRM."
    />
  );
}
