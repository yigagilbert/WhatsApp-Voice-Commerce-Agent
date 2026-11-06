'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { CommerceGrid, formatMinor } from '@/components/grid/commerce-grid';
import type { ProductStat } from '@/lib/types';
import { toMajorNumber } from '@vca/commerce/money';
import { photoUrl } from '@/lib/photo';
import { cellChange } from '@/lib/product-cell';
import { saveProductCell } from './actions';

type Row = ProductStat & {
  price: number;
  revenue: number;
  activeLabel: string;
  shownLabel: 'Shown' | 'Hidden';
};

/** At or below the product's own low-stock alert level (the level admins are alerted at). */
const isLow = (row: Row | undefined) =>
  row?.stockQuantity != null && row.reorderLevel != null && row.stockQuantity <= row.reorderLevel;

const REVERT = 'revert';

export function ProductsGrid({
  products,
  filteredView,
}: {
  products: ProductStat[];
  /** Set when the page shows only part of the catalogue. */
  filteredView?: string;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  /** Saves a price or stock edit; on failure the cell goes back to the saved value. */
  const saveCell = async (e: CellValueChangedEvent<Row>) => {
    if (!e.data || e.source === REVERT || e.newValue === e.oldValue) return;
    const field = e.colDef.field;
    const revert = (message: string) => {
      // Marked, so that putting the old value back isn't saved as another edit.
      e.node.setDataValue(e.column, e.oldValue, REVERT);
      setNotice({ ok: false, message: `${e.data?.name}: ${message}` });
    };
    const change = cellChange(field, e.newValue);
    if ('problem' in change) return revert(change.problem);
    const result = await saveProductCell(e.data.id, change);
    if (!result?.ok) return revert(result?.message ?? 'not saved');
    setNotice({
      ok: true,
      message:
        field === 'category'
          ? `${e.data.name}: category saved. The storefront shows it right away.`
          : field === 'shownLabel'
            ? `${e.data.name}: ${e.newValue === 'Shown' ? 'customers can see it on WhatsApp and the storefront.' : 'hidden from customers.'}`
            : field === 'price'
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
        shownLabel: p.visibleToCustomers === false ? 'Hidden' : 'Shown',
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
        field: 'category',
        headerName: 'Category',
        minWidth: 130,
        editable: (p) => !p.node.rowPinned,
        cellClass: 'cursor-text underline decoration-dotted decoration-slate-300',
        headerTooltip: 'Click to set the storefront category',
      },
      {
        field: 'shownLabel',
        headerName: 'Customers',
        minWidth: 110,
        editable: (p) => !p.node.rowPinned,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['Shown', 'Hidden'] },
        cellClass: 'cursor-text underline decoration-dotted decoration-slate-300',
        headerTooltip: 'Click to show or hide this product on WhatsApp and the storefront',
      },
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
      {
        colId: 'bargaining',
        headerName: 'Bargaining',
        minWidth: 170,
        headerTooltip: 'Open the product to change bargaining and quantity discounts',
        valueGetter: (p) => {
          const row = p.data;
          if (!row || p.node?.rowPinned) return '';
          const deals = row.quantityDiscounts?.length
            ? ` · ${row.quantityDiscounts.length} qty deal${row.quantityDiscounts.length > 1 ? 's' : ''}`
            : '';
          return row.bargainingEnabled && row.minPriceMinor != null
            ? `Open · min ${formatMinor(row.minPriceMinor, row.currency)}${deals}`
            : `Fixed price${deals}`;
        },
        cellClass: (p) =>
          String(p.value).startsWith('Open') ? 'text-emerald-700 font-medium' : 'text-slate-500',
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
        Click a price, stock count, category or Shown/Hidden to edit it in place; click anywhere
        else in a row to open the product.
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
        emptyMessage={
          filteredView
            ? `No products right now: ${filteredView}.`
            : 'No products yet. Use “Add product” to create your first one.'
        }
        height={420}
      />
    </div>
  );
}
