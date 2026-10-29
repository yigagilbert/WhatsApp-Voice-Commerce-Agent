'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatMinor } from '@/components/grid/commerce-grid';
import type { ProductStat } from '@/lib/types';
import { toMajorNumber } from '@vca/commerce/money';
import { photoUrl } from '@/lib/photo';

type Row = ProductStat & { price: number; revenue: number; activeLabel: string };

export function ProductsGrid({ products }: { products: ProductStat[] }) {
  const router = useRouter();
  const rows = useMemo<Row[]>(
    () =>
      products.map((p) => ({
        ...p,
        price: toMajorNumber(p.unitPriceMinor, p.currency),
        revenue: toMajorNumber(p.revenueMinor, p.currency),
        activeLabel: p.active ? 'Active' : 'Inactive',
      })),
    [products],
  );
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: 'photo',
        headerName: 'Photo',
        pinned: 'left',
        width: 76,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data?: Row; node: { rowPinned?: string | null } }) =>
          p.node.rowPinned || !p.data ? null : p.data.imageVersion ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated thumbnail
            <img
              src={photoUrl(p.data.id, p.data.imageVersion, 'thumb')}
              alt=""
              loading="lazy"
              className="my-1 h-8 w-8 rounded object-cover"
            />
          ) : (
            <span
              title="No photo yet: open the product to add one"
              className="my-1 inline-flex h-8 w-8 items-center justify-center rounded border border-dashed border-slate-300 text-[10px] text-slate-400"
            >
              +
            </span>
          ),
      },
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
      onRowClick={(row) => router.push(`/products/${row.id}`)}
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
      emptyMessage="No products yet. Use “Add product” to create your first one."
      height={420}
    />
  );
}
