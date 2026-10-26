'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import type { DisputeRow } from '@/lib/types';
import { toMajorNumber } from '@vca/commerce/money';

type Row = DisputeRow & { amount: number | null; opened: Date | null; due: Date | null };

const STATUS_TONES: Record<string, string> = {
  WAITING_FOR_SELLER_RESPONSE: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  OPEN: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  WAITING_FOR_BUYER_RESPONSE: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  UNDER_REVIEW: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  RESOLVED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

export function DisputeStatus({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-5 ring-1 ring-inset ${STATUS_TONES[status] ?? STATUS_TONES.OPEN}`}
    >
      {label}
    </span>
  );
}

export function DisputesGrid({ disputes }: { disputes: DisputeRow[] }) {
  const router = useRouter();
  const rows = useMemo<Row[]>(
    () =>
      disputes.map((d) => ({
        ...d,
        amount:
          d.amountMinor !== null && d.currency ? toMajorNumber(d.amountMinor, d.currency) : null,
        opened: d.openedAt ? new Date(d.openedAt) : null,
        due: d.sellerResponseDueAt ? new Date(d.sellerResponseDueAt) : null,
      })),
    [disputes],
  );
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: 'paypalDisputeId',
        headerName: 'Dispute',
        pinned: 'left',
        minWidth: 170,
        cellClass: 'font-medium',
      },
      {
        field: 'orderReference',
        headerName: 'Order',
        minWidth: 120,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : (p.value ?? 'Not matched')),
      },
      { field: 'customer', headerName: 'Customer', minWidth: 140 },
      { field: 'reasonLabel', headerName: 'Reason', minWidth: 160 },
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
      {
        field: 'status',
        headerName: 'Status',
        minWidth: 170,
        cellRenderer: (p: { data?: Row; node: { rowPinned?: string | null } }) =>
          p.node.rowPinned || !p.data ? null : (
            <DisputeStatus status={p.data.status} label={p.data.statusLabel} />
          ),
      },
      {
        field: 'opened',
        headerName: 'Opened',
        filter: 'agDateColumnFilter',
        sort: 'desc',
        minWidth: 160,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : formatDate(p.value)),
      },
      {
        field: 'due',
        headerName: 'Response due',
        filter: 'agDateColumnFilter',
        minWidth: 160,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : p.value ? formatDate(p.value) : '—'),
        cellClassRules: {
          'text-rose-700 font-medium': (p) =>
            !!p.value && p.data?.status === 'WAITING_FOR_SELLER_RESPONSE',
        },
      },
    ],
    [],
  );
  return (
    <CommerceGrid<Row>
      rows={rows}
      columns={columns}
      getRowId={(r) => r.id}
      statusField="status"
      statusOptions={[
        { label: 'Needs response', value: 'WAITING_FOR_SELLER_RESPONSE' },
        { label: 'Open', value: 'OPEN' },
        { label: 'Under review', value: 'UNDER_REVIEW' },
        { label: 'Waiting for buyer', value: 'WAITING_FOR_BUYER_RESPONSE' },
        { label: 'Resolved', value: 'RESOLVED' },
      ]}
      summarize={(visible) => {
        const currencies = [...new Set(visible.map((r) => r.currency).filter(Boolean))];
        return {
          paypalDisputeId: `${visible.length} disputes`,
          amountMinor:
            currencies.length === 1 ? visible.reduce((s, r) => s + (r.amountMinor ?? 0), 0) : null,
          currency: currencies.length === 1 ? currencies[0]! : null,
        } as Partial<Row>;
      }}
      onRowClick={(row) => router.push(`/disputes?d=${encodeURIComponent(row.paypalDisputeId)}`)}
      exportName="katale-disputes"
      searchPlaceholder="Search disputes…"
      emptyMessage="No PayPal disputes. New disputes arrive automatically from PayPal."
      height={440}
    />
  );
}
