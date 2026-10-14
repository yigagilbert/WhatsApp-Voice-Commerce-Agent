'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import { StatusPill } from '@/components/ui-client';
import type { Payment } from '@/lib/types';

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
