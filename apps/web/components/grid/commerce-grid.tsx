'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type CellClickedEvent,
  type CellValueChangedEvent,
  type IRowNode,
} from 'ag-grid-community';
import { formatMoney } from '@vca/commerce/money';

// AG Grid Community (MIT): sorting, filtering, pagination, resizing, CSV export.
ModuleRegistry.registerModules([AllCommunityModule]);

/** Matches the dashboard's slate palette so the grids feel native, not embedded. */
export const gridTheme = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  headerTextColor: '#475569',
  headerBackgroundColor: '#f8fafc',
  foregroundColor: '#0f172a',
  borderColor: '#e2e8f0',
  rowHoverColor: '#f8fafc',
  selectedRowBackgroundColor: '#f1f5f9',
  accentColor: '#0f172a',
  wrapperBorderRadius: 8,
  spacing: 7,
});

export interface StatusOption {
  label: string;
  value: string;
}

export interface CommerceGridProps<T> {
  rows: T[];
  columns: ColDef<T>[];
  /** Field holding the status used by the quick status chips. */
  statusField?: keyof T & string;
  statusOptions?: StatusOption[];
  /** Builds the pinned summary row from the rows currently passing all filters. */
  summarize?: (rows: T[]) => Partial<T>;
  /** Opens a row; clicks on editable cells start editing instead. */
  onRowClick?: (row: T) => void;
  /** Called after an editable cell (`editable` in its column) was changed in place. */
  onCellEdit?: (event: CellValueChangedEvent<T>) => void;
  exportName: string;
  searchPlaceholder?: string;
  emptyMessage: string;
  getRowId: (row: T) => string;
  height?: number;
}

export function CommerceGrid<T>({
  rows,
  columns,
  statusField,
  statusOptions,
  summarize,
  onRowClick,
  onCellEdit,
  exportName,
  searchPlaceholder = 'Search…',
  emptyMessage,
  getRowId,
  height = 560,
}: CommerceGridProps<T>) {
  const api = useRef<GridApi<T> | null>(null);
  const [quickFilter, setQuickFilter] = useState('');
  const [status, setStatus] = useState<string>('');
  const statusRef = useRef(status);
  const [shown, setShown] = useState(rows.length);
  const [summaryRow, setSummaryRow] = useState<Partial<T>[] | undefined>(undefined);

  const defaultColDef = useMemo<ColDef<T>>(
    () => ({ sortable: true, resizable: true, filter: true, minWidth: 110, flex: 1 }),
    [],
  );

  // Pages pass `summarize` inline (a new function each render) and a new pinned summary row makes
  // AG Grid fire rowDataUpdated again. Keep the callback stable and only update state when the
  // summary actually changed, otherwise the grid re-renders in a loop.
  const summarizeRef = useRef(summarize);
  useEffect(() => {
    summarizeRef.current = summarize;
  }, [summarize]);
  const lastSummary = useRef<string | null>(null);
  const refreshSummary = useCallback(() => {
    if (!api.current) return;
    const visible: T[] = [];
    api.current.forEachNodeAfterFilter((node: IRowNode<T>) => {
      if (node.data) visible.push(node.data);
    });
    setShown(visible.length);
    const summarizeRows = summarizeRef.current;
    if (!summarizeRows) return;
    const next = visible.length ? [summarizeRows(visible)] : undefined;
    const key = JSON.stringify(next ?? null);
    if (key === lastSummary.current) return;
    lastSummary.current = key;
    setSummaryRow(next);
  }, []);

  const chooseStatus = (value: string) => {
    statusRef.current = value;
    setStatus(value);
    api.current?.onFilterChanged();
  };

  const counts = useMemo(() => {
    if (!statusField) return {};
    const result: Record<string, number> = {};
    for (const row of rows) {
      const key = String(row[statusField]);
      result[key] = (result[key] ?? 0) + 1;
    }
    return result;
  }, [rows, statusField]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {statusOptions && statusField ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {[{ label: 'All', value: '' }, ...statusOptions].map((option) => {
              const active = status === option.value;
              const n = option.value ? (counts[option.value] ?? 0) : rows.length;
              return (
                <button
                  key={option.value || 'all'}
                  type="button"
                  onClick={() => chooseStatus(option.value)}
                  aria-pressed={active}
                  className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                    active
                      ? 'bg-slate-900 text-white ring-slate-900'
                      : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {option.label}{' '}
                  <span className={active ? 'text-slate-300' : 'text-slate-400'}>{n}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-slate-400 focus:outline-none sm:w-56"
          />
          <button
            type="button"
            onClick={() =>
              api.current?.exportDataAsCsv({
                fileName: `${exportName}-${new Date().toISOString().slice(0, 10)}.csv`,
                skipPinnedBottom: true,
              })
            }
            className="whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div style={{ height }} className="w-full">
        <AgGridReact<T>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={(p) => (p.rowPinned ? `pinned-${p.rowPinned}` : getRowId(p.data))}
          quickFilterText={quickFilter}
          isExternalFilterPresent={() => !!statusRef.current}
          doesExternalFilterPass={(node) =>
            !statusField || String(node.data?.[statusField]) === statusRef.current
          }
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[20, 50, 100]}
          pinnedBottomRowData={summaryRow}
          overlayNoRowsTemplate={`<span class="text-sm text-slate-500">${emptyMessage}</span>`}
          onGridReady={(e) => {
            api.current = e.api;
            refreshSummary();
          }}
          onFilterChanged={refreshSummary}
          onRowDataUpdated={refreshSummary}
          rowClass={onRowClick ? 'cursor-pointer' : undefined}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          onCellClicked={(e: CellClickedEvent<T>) => {
            if (!e.data || e.rowPinned || !onRowClick || e.column.isCellEditable(e.node)) return;
            onRowClick(e.data);
          }}
          onCellValueChanged={onCellEdit}
        />
      </div>
      <p className="text-xs text-slate-500">
        {shown} of {rows.length} shown · Click a column header to sort, use its menu to filter.
      </p>
    </div>
  );
}

/**
 * Formats integer minor units for display (grid cells). Currency-aware: UGX and other
 * zero-decimal currencies are stored without a minor unit and must not be divided by 100.
 */
export const formatMinor = (
  minor: number | null | undefined,
  currency: string | null | undefined,
) => {
  if (minor == null || !currency) return '';
  try {
    return formatMoney(minor, currency);
  } catch {
    return `${currency} ${minor}`;
  }
};

export const formatDate = (value: Date | string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '';
