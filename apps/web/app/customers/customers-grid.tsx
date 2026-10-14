'use client';

import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import type { CustomerStat } from '@/lib/types';

type Row = CustomerStat & { revenue: number; lastOrder: Date | null; contact: string };

const country = (code: string | null) => {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export function CustomersGrid({ customers }: { customers: CustomerStat[] }) {
  const rows = useMemo<Row[]>(
    () =>
      customers.map((c) => ({
        ...c,
        revenue: c.revenueMinor / 100,
        lastOrder: c.lastOrderAt ? new Date(c.lastOrderAt) : null,
        contact: [c.email, c.phone, c.hasWhatsApp ? 'WhatsApp' : null].filter(Boolean).join(' · '),
      })),
    [customers],
  );
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Customer',
        pinned: 'left',
        minWidth: 160,
        cellClass: 'font-medium',
      },
      {
        field: 'country',
        headerName: 'Country',
        minWidth: 130,
        valueFormatter: (p) => country(p.value),
      },
      {
        field: 'orders',
        headerName: 'Orders',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 100,
      },
      {
        field: 'paidOrders',
        headerName: 'Paid orders',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
      },
      {
        field: 'revenue',
        headerName: 'Revenue',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        sort: 'desc',
        minWidth: 120,
        valueFormatter: (p) => formatMinor(p.data?.revenueMinor, p.data?.currency),
        cellClass: 'tabular-nums font-medium',
      },
      {
        field: 'lastOrder',
        headerName: 'Last order',
        filter: 'agDateColumnFilter',
        minWidth: 170,
        valueFormatter: (p) =>
          p.node?.rowPinned ? '' : p.value ? formatDate(p.value) : 'No orders yet',
      },
      { field: 'contact', headerName: 'Contact', minWidth: 200, flex: 2 },
    ],
    [],
  );
  return (
    <CommerceGrid<Row>
      rows={rows}
      columns={columns}
      getRowId={(r) => r.id}
      summarize={(visible) => {
        const currencies = [...new Set(visible.map((r) => r.currency).filter(Boolean))];
        const one = currencies.length === 1 ? currencies[0]! : null;
        return {
          name: `${visible.length} customers`,
          orders: visible.reduce((s, r) => s + r.orders, 0),
          paidOrders: visible.reduce((s, r) => s + r.paidOrders, 0),
          revenueMinor: visible.reduce((s, r) => s + r.revenueMinor, 0),
          currency: one,
        } as Partial<Row>;
      }}
      exportName="katale-customers"
      searchPlaceholder="Search customers…"
      emptyMessage="No customers yet."
    />
  );
}
