import type { AgReportState } from 'ag-studio';

type Widgets = Record<string, unknown>;

export const title = (text: string) => ({
  title: {
    enabled: true,
    text,
    typography: { fontSize: 14, fontWeight: 'bold' },
    color: '#1c2329',
  },
});

export const kpi = (text: string, id: string, sparkline = false, aggregation = 'sum') => ({
  type: 'value',
  format: {
    ...title(text),
    style: {
      textScaling: { enabled: true },
      typography: { fontWeight: 'bold' },
      color: '#0b3d20',
      ...(sparkline ? { sparkline: { type: 'line', areaFill: true } } : {}),
    },
  },
  dataMapping: {
    value: [{ id, aggregation }],
    ...(sparkline ? { sparklineX: [{ id: 'payments.paidOn' }] } : {}),
  },
});

const bars = (text: string, category: string, value: string) => ({
  type: 'bar-chart-grouped',
  format: title(text),
  dataMapping: {
    categoryKey: [{ id: category }],
    valueKey: [{ id: value, aggregation: 'sum' }],
  },
  sort: [{ field: { id: value, aggregation: 'sum' }, direction: 'desc' }],
});

export const table = (
  text: string,
  cols: readonly string[],
  sort?: { id: string; direction: string },
) => ({
  type: 'grid',
  format: title(text),
  dataMapping: { cols: cols.map((id) => ({ id })) },
  ...(sort ? { sort: [{ field: { id: sort.id }, direction: sort.direction }] } : {}),
});

const is = (field: string, value: string) => ({
  field: { id: field },
  model: { operator: 'equals', value },
});
/** Sales only: requests that were never paid have no date to plot. */
export const salesOnly = [
  { field: { id: 'payments.gross' }, model: { operator: 'greaterThan', value: 0 } },
];

/** Worklists, shared by the standard report and the assistant. */
export const TABLES = {
  pending_payments: {
    title: 'Awaiting payment',
    cols: [
      'orders.orderId',
      'orders.customer',
      'orders.source',
      'orders.total',
      'orders.createdAt',
    ],
    sort: { id: 'orders.createdAt', direction: 'desc' },
    filter: [is('orders.status', 'Awaiting payment')],
  },
  orders_to_ship: {
    title: 'Paid, not shipped',
    cols: ['orders.orderId', 'orders.customer', 'orders.total', 'orders.paidAt'],
    sort: { id: 'orders.paidAt', direction: 'asc' },
    filter: [is('orders.toShip', 'Yes')],
  },
  active_disputes: {
    title: 'Active disputes',
    cols: [
      'disputes.disputeId',
      'disputes.orderId',
      'disputes.status',
      'disputes.amount',
      'disputes.responseDue',
    ],
    sort: { id: 'disputes.responseDue', direction: 'asc' },
    filter: [is('disputes.active', 'Yes')],
  },
  stock_levels: {
    title: 'Stock and sales',
    cols: [
      'products.product',
      'products.category',
      'products.stockStatus',
      'products.stock',
      'products.reorderLevel',
      'products.unitsSold',
      'products.revenue',
    ],
    sort: { id: 'products.stock', direction: 'asc' },
  },
  low_stock: {
    title: 'Low and out of stock',
    cols: [
      'products.product',
      'products.stockStatus',
      'products.stock',
      'products.reorderLevel',
      'products.unitsSold',
    ],
    sort: { id: 'products.stock', direction: 'asc' },
    filter: [
      {
        field: { id: 'products.stockStatus' },
        model: { operator: 'isIn', value: ['Low stock', 'Out of stock'] },
      },
    ],
  },
} as const;

export type TablePreset = keyof typeof TABLES;

const worklist = (preset: TablePreset) => {
  const { title: text, cols, sort } = TABLES[preset];
  return table(text, [...cols], sort);
};

export const tableFilters = (preset: TablePreset): unknown[] | undefined => {
  const definition = TABLES[preset];
  return 'filter' in definition ? [...definition.filter] : undefined;
};

const page = (
  id: string,
  widgets: Widgets,
  layout: Record<string, [number, number, number, number]>,
  filter?: Record<string, unknown[]>,
) => ({
  id,
  widgets,
  widgetLayout: Object.fromEntries(
    Object.entries(layout).map(([key, [xTrack, yTrack, xSpan, ySpan]]) => [
      key,
      { xTrack, yTrack, xSpan, ySpan },
    ]),
  ),
  ...(filter ? { filter: { widget: filter } } : {}),
});

/**
 * The dashboard every merchant starts from, useful without customizing anything. Revenue always
 * comes from Payments' Net revenue, the same rule the headline figures use, and the amounts are
 * already zero on rows that are not sales, so no widget depends on a filter for its accuracy.
 */
export const defaultReport = {
  pages: [
    page(
      'performance',
      {
        period: {
          type: 'date-filter',
          format: { ...title('Paid between'), style: { filterType: 'between' } },
          dataMapping: { value: [{ id: 'payments.paidOn' }] },
        },
        net: kpi('Net revenue', 'payments.net', true),
        gross: kpi('Gross sales', 'payments.gross'),
        refunds: kpi('Refunds', 'payments.refunded'),
        completed: kpi('Completed orders', 'payments.paidOrders'),
        trend: {
          type: 'area-chart',
          format: title('Net revenue over time'),
          dataMapping: {
            categoryKey: [{ id: 'payments.paidOn' }],
            valueKey: [{ id: 'payments.net', aggregation: 'sum' }],
          },
        },
        channels: {
          type: 'donut-chart',
          format: title('Net revenue by channel'),
          dataMapping: {
            categoryKey: [{ id: 'payments.source' }],
            valueKey: [{ id: 'payments.net', aggregation: 'sum' }],
          },
        },
        products: bars('Best-selling products', 'orderItems.product', 'orderItems.soldAmount'),
        customers: bars('Top customers', 'payments.customer', 'payments.net'),
        statuses: {
          type: 'donut-chart',
          format: title('Orders by status'),
          dataMapping: {
            categoryKey: [{ id: 'orders.status' }],
            valueKey: [{ id: 'orders.orderId', aggregation: 'count' }],
          },
        },
      },
      {
        period: [0, 0, 6, 7],
        net: [6, 0, 6, 7],
        gross: [12, 0, 4, 7],
        refunds: [16, 0, 4, 7],
        completed: [20, 0, 4, 7],
        trend: [0, 7, 16, 15],
        channels: [16, 7, 8, 15],
        products: [0, 22, 10, 16],
        customers: [10, 22, 7, 16],
        statuses: [17, 22, 7, 16],
      },
      { net: salesOnly, trend: salesOnly },
    ),
    page(
      'inventory',
      {
        stockStates: {
          type: 'donut-chart',
          format: title('Catalog by stock status'),
          dataMapping: {
            categoryKey: [{ id: 'products.stockStatus' }],
            valueKey: [{ id: 'products.product', aggregation: 'count' }],
          },
        },
        revenue: bars('Product revenue', 'products.product', 'products.revenue'),
        stock: worklist('stock_levels'),
      },
      {
        stockStates: [0, 0, 8, 16],
        revenue: [8, 0, 16, 16],
        stock: [0, 16, 24, 18],
      },
      { stockStates: [{ field: { id: 'products.active' }, model: { operator: 'isTrue' } }] },
    ),
    page(
      'payments',
      {
        pending: kpi('Pending PayPal payments', 'payments.pending'),
        refunded: kpi('Refunded', 'payments.refunded'),
        paymentStates: {
          type: 'donut-chart',
          format: title('Payments by status'),
          dataMapping: {
            categoryKey: [{ id: 'payments.status' }],
            valueKey: [{ id: 'payments.paymentId', aggregation: 'count' }],
          },
        },
        awaiting: worklist('pending_payments'),
        toShip: worklist('orders_to_ship'),
        disputes: worklist('active_disputes'),
      },
      {
        pending: [0, 0, 6, 6],
        refunded: [0, 6, 6, 6],
        paymentStates: [6, 0, 6, 12],
        awaiting: [12, 0, 12, 12],
        toShip: [0, 12, 12, 14],
        disputes: [12, 12, 12, 14],
      },
      {
        awaiting: tableFilters('pending_payments') ?? [],
        toShip: tableFilters('orders_to_ship') ?? [],
        disputes: tableFilters('active_disputes') ?? [],
      },
    ),
  ],
  selectedPageId: 'performance',
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } },
  version: '3.0.0',
} as unknown as AgReportState;

/** Tab names for the standard pages. Pages merchants or the assistant add are simply numbered. */
export const PAGE_LABELS: Record<string, string> = {
  performance: 'Performance',
  inventory: 'Products & inventory',
  payments: 'Payments & shipping',
  'ai-dashboard': 'AI dashboard',
};
