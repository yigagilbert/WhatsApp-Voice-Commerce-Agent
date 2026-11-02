'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { CommerceGrid, formatMinor } from '@/components/grid/commerce-grid';
import type { ProductStat } from '@/lib/types';
import { toMajorNumber } from '@vca/commerce/money';
import { photoUrl } from '@/lib/photo';
import { saveProductCell } from './actions';

type Row = ProductStat & { price: number; revenue: number; activeLabel: string };

/** At or below the product's own low-stock alert level (the level admins are alerted at). */
const isLow = (row: Row | undefined) =>
  row?.stockQuantity != null && row.reorderLevel != null && row.stockQuantity <= row.reorderLevel;

export function ProductsGrid({ products }: { products: ProductStat[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  /** Saves a price or stock edit; on failure the cell goes back to the saved value. */
  const saveCell = async (e: CellValueChangedEvent<Row>) => {
    if (!e.data || e.newValue === e.oldValue) return;
    const field = e.colDef.field;
    const value = Number(e.newValue);
    const change = field === 'price' ? { price: value.toFixed(2) } : { stock: Math.round(value) };
    const result = await saveProductCell(e.data.id, change);
    if (!result?.ok) {
      e.node.setDataValue(e.column, e.oldValue);
      setNotice({ ok: false, message: `${e.data.name}: ${result?.message ?? 'not saved'}` });
      return;
    }
    setNotice({
      ok: true,
      message:
        field === 'price'
          ? `${e.data.name}: price saved. New orders use it; existing orders keep theirs.`
          : `${e.data.name}: stock count saved to the stock ledger.`,
    });
    router.refresh();
  };
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
        // Whole-unit currencies (UGX) have no decimals; editing in major units works for both.
        editable: (p) => !p.node.rowPinned,
        cellEditor: 'agNumberCellEditor',
        cellEditorParams: { min: 0.01, precision: 2 },
        valueFormatter: (p) =>
          p.node?.rowPinned ? '' : formatMinor(p.data?.unitPriceMinor, p.data?.currency),
        cellClass: 'tabular-nums cursor-text underline decoration-dotted decoration-slate-300',
        headerTooltip: 'Click a price to change it',
      },
      { field: 'currency', headerName: 'Currency', minWidth: 80, maxWidth: 100 },
      {
        field: 'stockQuantity',
        headerName: 'Inventory',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        // Only tracked stock is edited here; turning tracking on is done in the product editor.
        editable: (p) => !p.node.rowPinned && p.data?.stockQuantity != null,
        cellEditor: 'agNumberCellEditor',
        cellEditorParams: { min: 0, precision: 0 },
        valueFormatter: (p) =>
          p.node?.rowPinned
            ? ''
            : p.value == null
              ? 'Not tracked'
              : p.value === 0
                ? '0 · out of stock'
                : isLow(p.data)
                  ? `${p.value} · low`
                  : String(p.value),
        cellClassRules: {
          'text-red-700 font-medium': (p) => p.value === 0,
          'text-amber-700 font-medium': (p) => p.value !== 0 && isLow(p.data),
          'cursor-text underline decoration-dotted decoration-slate-300': (p) => p.value != null,
        },
        headerTooltip: 'Click a stock count to correct it (recorded in the stock ledger)',
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
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        Click a price or stock count to edit it in place; click anywhere else in a row to open the
        product.
      </p>
      {notice && (
        <p role="status" className={`text-sm ${notice.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {notice.message}
        </p>
      )}
      <CommerceGrid<Row>
        onRowClick={(row) => router.push(`/products/${row.id}`)}
        onCellEdit={(e) => void saveCell(e)}
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
    </div>
  );
}
