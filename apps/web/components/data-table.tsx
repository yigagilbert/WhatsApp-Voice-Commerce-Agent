import type { ReactNode } from 'react';

/**
 * Column definitions deliberately mirror AG Grid's ColDef (`field`, `headerName`,
 * `valueFormatter`, `cellRenderer`) so tables can move to AG Grid by swapping this
 * component, without rewriting the pages that define columns.
 */
export interface ColumnDef<T> {
  field: keyof T & string;
  headerName: string;
  valueFormatter?: (row: T) => string;
  cellRenderer?: (row: T) => ReactNode;
  align?: 'left' | 'right';
}

export function DataTable<T extends { id: string }>({
  rowData,
  columnDefs,
  emptyMessage = 'Nothing here yet.',
}: {
  rowData: T[];
  columnDefs: ColumnDef<T>[];
  emptyMessage?: string;
}) {
  if (rowData.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {columnDefs.map((col) => (
              <th
                key={col.field}
                scope="col"
                className={`px-4 py-2.5 font-medium text-slate-600 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {col.headerName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rowData.map((row) => (
            <tr key={row.id} className="hover:bg-slate-50">
              {columnDefs.map((col) => (
                <td
                  key={col.field}
                  className={`px-4 py-2.5 text-slate-800 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
                >
                  {col.cellRenderer
                    ? col.cellRenderer(row)
                    : col.valueFormatter
                      ? col.valueFormatter(row)
                      : String(row[col.field] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
