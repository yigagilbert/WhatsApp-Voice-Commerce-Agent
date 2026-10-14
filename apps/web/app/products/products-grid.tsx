'use client';

import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatMinor } from '@/components/grid/commerce-grid';
import type { ProductStat } from '@/lib/types';

type Row = ProductStat & { price: number; revenue: number; activeLabel: string };

export function ProductsGrid({ products }: { products: ProductStat[] }) {
  const rows = useMemo<Row[]>(
    () =>
      products.map((p) => ({
        ...p,
        price: p.unitPriceMinor / 100,
        revenue: p.revenueMinor / 100,
        activeLabel: p.active ? 'Active' : 'Inactive',
      })),
    [products],
  );
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: 'name',
        headerName: 'Product',
        pinned: 'left',
        minWidth: 170,
        cellClass: 'font-medium',
      },
      { field: 'sku', headerName: 'SKU', minWidth: 120 },
      {
        field: 'price',
        headerName: 'Price',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 100,
        valueFormatter: (p) =>
          p.node?.rowPinned ? '' : formatMinor(p.data?.unitPriceMinor, p.data?.currency),
        cellClass: 'tabular-nums',
      },
      { field: 'currency', headerName: 'Currency', minWidth: 80, maxWidth: 100 },
      {
        field: 'stockQuantity',
        headerName: 'Inventory',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueFormatter: (p) =>
          p.node?.rowPinned ? '' : p.value == null ? 'Not tracked' : String(p.value),
        cellClassRules: { 'text-amber-700 font-medium': (p) => p.value != null && p.value < 20 },
      },
      {
        field: 'unitsSold',
        headerName: 'Units sold (paid)',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 140,
      },
      {
        field: 'revenue',
        headerName: 'Revenue (paid)',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        sort: 'desc',
        minWidth: 140,
        valueFormatter: (p) => formatMinor(p.data?.revenueMinor, p.data?.currency),
        cellClass: 'tabular-nums font-medium',
      },
      { field: 'activeLabel', headerName: 'Active', minWidth: 100 },
    ],
    [],
  );
  return (
    <CommerceGrid<Row>
      rows={rows}
      columns={columns}
      getRowId={(r) => r.id}
      statusField="activeLabel"
      statusOptions={[
        { label: 'Active', value: 'Active' },
        { label: 'Inactive', value: 'Inactive' },
      ]}
      summarize={(visible) => {
        const currencies = [...new Set(visible.map((r) => r.currency))];
        return {
          name: `${visible.length} products`,
          unitsSold: visible.reduce((s, r) => s + r.unitsSold, 0),
          revenueMinor: visible.reduce((s, r) => s + r.revenueMinor, 0),
          currency: currencies.length === 1 ? currencies[0]! : '',
        } as Partial<Row>;
      }}
      exportName="katale-products"
      searchPlaceholder="Search products…"
      emptyMessage="No products yet."
      height={420}
    />
  );
}
