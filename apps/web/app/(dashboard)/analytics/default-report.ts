import type { AgReportState } from 'ag-studio';

/**
 * The dashboard AG Studio opens with. It was first built by AG Studio's own AI assistant
 * (through Katale's /studio-ai proxy) from the request "Build a merchant sales dashboard…",
 * captured with `api.getState()`, and then given clearer titles. Merchants can change it freely.
 */
const paid = [{ field: { id: 'orders.status' }, model: { operator: 'equals', value: 'Paid' } }];

export const defaultReport = {
  pages: [
    {
      id: 'sales-overview',
      widgets: {
        revenue: {
          type: 'value',
          format: {
            title: { enabled: true, text: 'Revenue (paid orders)' },
            subtitle: { enabled: false },
            style: { textScaling: { enabled: true } },
          },
          dataMapping: { value: [{ id: 'orders.total', aggregation: 'sum' }] },
        },
        paidOrders: {
          type: 'value',
          format: { title: { enabled: true, text: 'Paid orders' } },
          dataMapping: { value: [{ id: 'orders.orderId', aggregation: 'count' }] },
        },
        bySource: {
          type: 'bar-chart-grouped',
          format: { title: { enabled: true, text: 'Revenue by source (voice vs text)' } },
          dataMapping: {
            categoryKey: [{ id: 'orders.source' }],
            valueKey: [{ id: 'orders.total', aggregation: 'sum' }],
          },
          sort: [{ field: { id: 'orders.total', aggregation: 'sum' }, direction: 'desc' }],
        },
        byProduct: {
          type: 'bar-chart-grouped',
          format: { title: { enabled: true, text: 'Product revenue (paid, excl. shipping)' } },
          dataMapping: {
            categoryKey: [{ id: 'orderItems.product' }],
            valueKey: [{ id: 'orderItems.lineTotal', aggregation: 'sum' }],
          },
          sort: [{ field: { id: 'orderItems.lineTotal', aggregation: 'sum' }, direction: 'desc' }],
        },
        awaiting: {
          type: 'grid',
          format: { title: { enabled: true, text: 'Orders awaiting payment' } },
          dataMapping: {
            cols: [
              { id: 'orders.orderId' },
              { id: 'orders.customer' },
              { id: 'orders.total' },
              { id: 'orders.createdAt' },
            ],
          },
          sort: [{ field: { id: 'orders.createdAt' }, direction: 'desc' }],
        },
      },
      widgetLayout: {
        revenue: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 6 },
        paidOrders: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 6 },
        bySource: { xTrack: 0, yTrack: 6, xSpan: 12, ySpan: 18 },
        byProduct: { xTrack: 12, yTrack: 6, xSpan: 12, ySpan: 18 },
        awaiting: { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 12 },
      },
      filter: {
        widget: {
          revenue: paid,
          paidOrders: paid,
          bySource: paid,
          byProduct: paid,
          awaiting: [
            {
              field: { id: 'orders.status' },
              model: { operator: 'equals', value: 'Awaiting payment' },
            },
          ],
        },
      },
    },
  ],
  selectedPageId: 'sales-overview',
  // Open with the canvas and the AI assistant; filters, widget editor and data list are one click away.
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } },
  version: '3.0.0',
} as unknown as AgReportState;
