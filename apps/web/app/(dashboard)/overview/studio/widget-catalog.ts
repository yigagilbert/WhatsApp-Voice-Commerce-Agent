import type { AgReportState } from 'ag-studio';
import {
  kpi,
  salesOnly,
  table,
  title,
  tableFilters,
  TABLES,
  type TablePreset,
} from './default-report';

/**
 * What the assistant may put on a dashboard: known-good measures and groupings, nothing else. A
 * model given free rein over fields and widget types invents ones that don't exist, or sums the
 * wrong column. This way every AI chart uses the same revenue rules as the rest of the Overview.
 * Pure functions, unit-tested.
 */
export const METRICS = {
  net_revenue: { field: 'payments.net', label: 'Net revenue', aggregation: 'sum' },
  gross_sales: { field: 'payments.gross', label: 'Gross sales', aggregation: 'sum' },
  refunds: { field: 'payments.refunded', label: 'Refunds', aggregation: 'sum' },
  completed_orders: { field: 'payments.paidOrders', label: 'Completed orders', aggregation: 'sum' },
  pending_payments: { field: 'payments.pending', label: 'Pending payments', aggregation: 'sum' },
  product_revenue: { field: 'orderItems.soldAmount', label: 'Sales', aggregation: 'sum' },
  units_sold: { field: 'orderItems.soldUnits', label: 'Units sold', aggregation: 'sum' },
  stock_on_hand: { field: 'products.stock', label: 'Stock on hand', aggregation: 'sum' },
  order_count: { field: 'orders.orderId', label: 'Orders', aggregation: 'count' },
} as const;

export const GROUPINGS = {
  payments: {
    day: 'payments.paidOn',
    channel: 'payments.source',
    customer: 'payments.customer',
    payment_status: 'payments.status',
  },
  orderItems: {
    day: 'orderItems.paidOn',
    channel: 'orderItems.source',
    product: 'orderItems.product',
  },
  products: {
    product: 'products.product',
    category: 'products.category',
    stock_status: 'products.stockStatus',
  },
  orders: {
    day: 'orders.createdOn',
    channel: 'orders.source',
    order_status: 'orders.status',
    fulfillment: 'orders.fulfillment',
  },
} as const;

const CHART_TYPES = {
  bar: 'bar-chart-grouped',
  column: 'column-chart-grouped',
  line: 'line-chart',
  area: 'area-chart',
  donut: 'donut-chart',
} as const;

export type MetricId = keyof typeof METRICS;
export type ChartType = keyof typeof CHART_TYPES | 'kpi';
export const METRIC_IDS = Object.keys(METRICS) as MetricId[];
export const CHART_TYPE_IDS = [...Object.keys(CHART_TYPES), 'kpi'] as ChartType[];
export const GROUP_IDS = [...new Set(Object.values(GROUPINGS).flatMap((g) => Object.keys(g)))];
export const TABLE_IDS = Object.keys(TABLES) as TablePreset[];

export const AI_PAGE_ID = 'ai-dashboard';
const COLUMNS = 24;
const SIZES = { kpi: [4, 6], chart: [12, 14], table: [24, 14] } as const;

export interface ChartSpec {
  metric: MetricId;
  chart: ChartType;
  groupBy?: string | undefined;
  title?: string | undefined;
}

type Page = NonNullable<AgReportState['pages']>[number];
type Layout = Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number }>;

const asLayout = (page: Page) => (page.widgetLayout ?? {}) as Layout;

/** The first free spot: beside the last row's widgets if they fit, otherwise on a new row. */
function nextSlot(layout: Layout, [xSpan, ySpan]: readonly [number, number]) {
  const boxes = Object.values(layout);
  const bottom = boxes.reduce((rows, box) => Math.max(rows, box.yTrack + box.ySpan), 0);
  const lastRow = boxes.reduce((y, box) => Math.max(y, box.yTrack), 0);
  const end = boxes
    .filter((box) => box.yTrack === lastRow)
    .reduce((x, box) => Math.max(x, box.xTrack + box.xSpan), 0);
  const sameHeight = boxes
    .filter((box) => box.yTrack === lastRow)
    .every((box) => box.ySpan === ySpan);
  return boxes.length > 0 && sameHeight && end + xSpan <= COLUMNS
    ? { xTrack: end, yTrack: lastRow, xSpan, ySpan }
    : { xTrack: 0, yTrack: bottom, xSpan, ySpan };
}

/** Adds a widget to the assistant's own page, creating and opening it, so standard pages stay tidy. */
function place(
  state: AgReportState,
  widget: unknown,
  size: readonly [number, number],
  filters?: unknown[],
): { state: AgReportState; widgetId: string } {
  const pages = state.pages ?? [];
  const existing = pages.find((p) => p.id === AI_PAGE_ID);
  const page = (existing ?? {
    id: AI_PAGE_ID,
    widgets: {},
    widgetLayout: {},
    filter: { widget: {} },
  }) as Page;
  const layout = asLayout(page);
  let n = Object.keys(page.widgets ?? {}).length + 1;
  while ((page.widgets ?? {})[`ai-${n}`]) n += 1;
  const widgetId = `ai-${n}`;
  const updated = {
    ...page,
    widgets: { ...page.widgets, [widgetId]: widget },
    widgetLayout: { ...layout, [widgetId]: nextSlot(layout, size) },
    filter: {
      ...page.filter,
      widget: { ...page.filter?.widget, ...(filters ? { [widgetId]: filters } : {}) },
    },
  } as Page;
  return {
    widgetId,
    state: {
      ...state,
      selectedPageId: AI_PAGE_ID,
      pages: existing ? pages.map((p) => (p.id === AI_PAGE_ID ? updated : p)) : [...pages, updated],
    } as AgReportState,
  };
}

export type CatalogResult =
  { ok: true; state: AgReportState; widgetId: string } | { ok: false; error: string };

export function addChart(state: AgReportState, spec: ChartSpec): CatalogResult {
  const metric = METRICS[spec.metric];
  if (!metric) return { ok: false, error: `Unknown metric. Use one of: ${METRIC_IDS.join(', ')}.` };
  const tableId = metric.field.split('.')[0] as keyof typeof GROUPINGS;
  const heading = spec.title?.trim() || metric.label;
  const measure = { id: metric.field, aggregation: metric.aggregation };

  if (spec.chart === 'kpi') {
    const widget = kpi(heading, metric.field, false, metric.aggregation);
    return { ok: true, ...place(state, widget, SIZES.kpi) };
  }
  const chartType = CHART_TYPES[spec.chart];
  if (!chartType)
    return { ok: false, error: `Unknown chart. Use one of: ${CHART_TYPE_IDS.join(', ')}.` };
  const groups = GROUPINGS[tableId] as Record<string, string>;
  const category = spec.groupBy ? groups[spec.groupBy] : undefined;
  if (tableId === 'payments' && spec.groupBy === 'product')
    return {
      ok: false,
      error: `${metric.label} isn't recorded per product. For revenue by product, use product_revenue, which shows sales before refunds, and say so.`,
    };
  if (!category)
    return {
      ok: false,
      error: `${metric.label} can be grouped by: ${Object.keys(groups).join(', ')}.`,
    };
  const overTime = spec.groupBy === 'day';
  if (overTime && spec.metric === 'pending_payments')
    return {
      ok: false,
      error: 'Pending payments have no paid date. Group them by channel or customer.',
    };
  // A line implies time; anything else reads better as a ranking.
  const isTimeChart = spec.chart === 'line' || spec.chart === 'area';
  const widget = {
    type: overTime
      ? spec.chart === 'bar'
        ? CHART_TYPES.column
        : chartType
      : isTimeChart
        ? CHART_TYPES.bar
        : chartType,
    format: title(heading),
    dataMapping: { categoryKey: [{ id: category }], valueKey: [measure] },
    ...(overTime ? {} : { sort: [{ field: measure, direction: 'desc' }] }),
  };
  // Only sales have a paid date; leave the rest off a time axis.
  const filters = overTime && tableId === 'payments' ? salesOnly : undefined;
  return { ok: true, ...place(state, widget, SIZES.chart, filters) };
}

export function addTable(state: AgReportState, preset: TablePreset): CatalogResult {
  const definition = TABLES[preset];
  if (!definition)
    return { ok: false, error: `Unknown table. Use one of: ${TABLE_IDS.join(', ')}.` };
  const widget = table(definition.title, definition.cols, definition.sort);
  return { ok: true, ...place(state, widget, SIZES.table, tableFilters(preset)) };
}
