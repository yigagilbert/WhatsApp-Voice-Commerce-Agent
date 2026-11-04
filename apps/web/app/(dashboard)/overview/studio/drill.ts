import type { AgActiveFilters, AgFilterDefinition, AgReportState } from 'ag-studio';
import { table, title } from './default-report';

/**
 * Drill-through: right-click a bar, slice or row to see the records behind it. AG Studio supplies
 * the clicked values and applies the filter; this decides what to show for them. Tables are chosen by
 * where the clicked field lives, because products and disputes aren't joined to payments.
 */
const RECORD_TABLES: Record<string, { text: string; cols: string[] }[]> = {
  products: [
    {
      text: 'Products',
      cols: [
        'products.product',
        'products.category',
        'products.stockStatus',
        'products.stock',
        'products.reorderLevel',
        'products.unitsSold',
        'products.revenue',
      ],
    },
  ],
  disputes: [
    {
      text: 'Disputes',
      cols: [
        'disputes.disputeId',
        'disputes.orderId',
        'disputes.reason',
        'disputes.status',
        'disputes.amount',
        'disputes.responseDue',
      ],
    },
  ],
  sales: [
    {
      text: 'Payments',
      cols: [
        'payments.orderId',
        'payments.customer',
        'payments.source',
        'payments.status',
        'payments.gross',
        'payments.refunded',
        'payments.net',
        'payments.paidOn',
      ],
    },
    {
      text: 'Items',
      cols: [
        'orderItems.orderId',
        'orderItems.product',
        'orderItems.orderStatus',
        'orderItems.quantity',
        'orderItems.soldAmount',
        'orderItems.paidOn',
      ],
    },
  ],
};

export const DRILL_PAGE_ID = 'records';
const TABLE_ROWS = 16;

interface Condition {
  field?: { id?: string };
  value?: unknown;
  conditions?: Condition[];
}

const leaves = (filter: Condition): Condition[] =>
  filter.conditions ? filter.conditions.flatMap(leaves) : [filter];

/** The report showing the records behind a filter on `field`. */
export function drillReport(filter: AgFilterDefinition): AgReportState {
  const table_ = leaves(filter as Condition)[0]?.field?.id?.split('.')[0] ?? '';
  const tables = RECORD_TABLES[table_] ?? RECORD_TABLES.sales ?? [];
  const entries = tables.map(({ text, cols }, index) => ({
    id: `records-${index}`,
    widget: { ...table(text, cols), format: title(text) },
    box: { xTrack: 0, yTrack: index * TABLE_ROWS, xSpan: 24, ySpan: TABLE_ROWS },
  }));
  return {
    pages: [
      {
        id: DRILL_PAGE_ID,
        widgets: Object.fromEntries(entries.map((e) => [e.id, e.widget])),
        widgetLayout: Object.fromEntries(entries.map((e) => [e.id, e.box])),
      },
    ],
    selectedPageId: DRILL_PAGE_ID,
    version: '3.1.0',
  } as unknown as AgReportState;
}

/** The clicked values, narrowed by whatever was already filtering that widget. */
export function drillFilter(clicked: AgFilterDefinition, active: AgActiveFilters = {}) {
  const conditions = [clicked, active.page, active.widget, active.crossFilter].filter(
    (c): c is AgFilterDefinition => c != null,
  );
  return conditions.length > 1
    ? ({ operator: 'AND', conditions } as unknown as AgFilterDefinition)
    : clicked;
}

/** The clicked values in words, e.g. "Kitenge shirt". */
export const describeDrill = (clicked: AgFilterDefinition) =>
  leaves(clicked as Condition)
    .map((c) => String(c.value ?? ''))
    .filter(Boolean)
    .join(', ') || 'this selection';
