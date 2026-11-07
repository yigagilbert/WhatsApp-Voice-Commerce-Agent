import type { AgReportState } from 'ag-studio';
import { describe, expect, it } from 'vitest';
import type { AnalyticsDataset } from './types';
import { addChart, addTable, AI_PAGE_ID } from '../app/(dashboard)/overview/studio/widget-catalog';
import { toolLabel } from '../app/(dashboard)/overview/studio/prompts';
import { createLookups } from '../app/(dashboard)/overview/studio/lookups';
import { scopeDataset } from '../app/(dashboard)/overview/studio/data-sources';
import { defaultReport } from '../app/(dashboard)/overview/studio/default-report';
import { layoutSignature, pageRows, stackBoxes } from '../app/(dashboard)/overview/studio/layout';
import { describeDrill, drillFilter, drillReport } from '../app/(dashboard)/overview/studio/drill';

const dataset: AnalyticsDataset = {
  meta: { generatedAt: '2026-11-04T00:00:00Z', timezone: 'Africa/Kampala', truncated: false },
  orders: [
    { orderId: 'A', currency: 'USD' },
    { orderId: 'B', currency: 'UGX' },
  ],
  orderItems: [
    { orderId: 'A', currency: 'USD' },
    { orderId: 'B', currency: 'UGX' },
  ],
  payments: [
    { orderId: 'A', currency: 'USD', net: 10 },
    { orderId: 'B', currency: 'UGX', net: 37_000 },
  ],
  disputes: [{ orderId: 'B', currency: 'UGX' }],
  products: [{ sku: 'P', currency: 'USD' }],
  shipments: [{ orderId: 'A' }, { orderId: 'B' }],
  customers: [{ customerId: 'C' }],
};

describe('scopeDataset', () => {
  it('never lets two currencies reach AG Studio together', () => {
    const usd = scopeDataset(dataset, 'USD');
    for (const rows of [usd.orders, usd.orderItems, usd.payments, usd.products])
      expect(rows.every((row) => row.currency === 'USD')).toBe(true);
    expect(usd.payments.map((p) => p.net)).toEqual([10]);
    expect(usd.disputes).toEqual([]);
    expect(usd.shipments).toEqual([{ orderId: 'A' }]);
  });

  it('keeps customers, who have no currency', () => {
    expect(scopeDataset(dataset, 'UGX').customers).toHaveLength(1);
  });
});

describe('dashboard layout helpers', () => {
  it('stacks widgets in reading order with the smallest KPIs in pairs, keeping the given order', () => {
    const boxes = [
      { xTrack: 12, yTrack: 0, xSpan: 4, ySpan: 7 }, // gross
      { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 }, // filter
      { xTrack: 16, yTrack: 0, xSpan: 4, ySpan: 7 }, // refunds
      { xTrack: 0, yTrack: 7, xSpan: 16, ySpan: 15 }, // trend
    ];
    expect(stackBoxes(boxes)).toEqual([
      { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 5 },
      { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 7 },
      { xTrack: 12, yTrack: 7, xSpan: 12, ySpan: 5 },
      { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 15 },
    ]);
  });

  it('measures the phone layout when the canvas is narrow', () => {
    expect(pageRows(defaultReport, true)).toBeGreaterThan(pageRows(defaultReport));
  });

  it('measures the selected page', () => {
    expect(pageRows(defaultReport)).toBe(38);
    expect(pageRows({ ...defaultReport, selectedPageId: 'inventory' })).toBe(34);
  });

  it('ignores filter values and view state when deciding a dashboard changed', () => {
    const page = defaultReport.pages?.[0];
    const filtered = {
      ...defaultReport,
      selectedPageId: 'payments',
      pages: [{ ...page, filter: { page: [] } }, ...(defaultReport.pages ?? []).slice(1)],
    } as AgReportState;
    expect(layoutSignature(filtered)).toBe(layoutSignature(defaultReport));
    const moved = {
      ...defaultReport,
      pages: [{ ...page, widgets: {} }, ...(defaultReport.pages ?? []).slice(1)],
    } as AgReportState;
    expect(layoutSignature(moved)).not.toBe(layoutSignature(defaultReport));
  });
});

describe('the default report', () => {
  it('takes every revenue figure from fields that are zero on non-sales', () => {
    const json = JSON.stringify(defaultReport);
    const forbidden = ['payments.amount', 'orderItems.lineTotal'];
    for (const field of forbidden) expect(json).not.toContain(field);
    // Order total only appears on the unpaid and to-ship worklists, never in a sum.
    const page = defaultReport.pages?.find((p) => p.id === 'performance');
    expect(JSON.stringify(page)).not.toContain('orders.total');
  });
});

describe('assistant lookups', () => {
  const shop: AnalyticsDataset = {
    meta: { generatedAt: '', timezone: 'Africa/Kampala', truncated: false },
    orders: [
      {
        orderId: 'A',
        customer: 'Sarah',
        toShip: 'Yes',
        total: 50,
        paidAt: '2026-11-02T10:00:00Z',
        paidOn: '2026-11-02',
      },
      {
        orderId: 'B',
        customer: 'John',
        toShip: 'Yes',
        total: 20,
        paidAt: '2026-10-30T10:00:00Z',
        paidOn: '2026-10-30',
      },
      { orderId: 'C', customer: 'Grace', toShip: 'No', total: 30, paidAt: null, paidOn: null },
    ],
    orderItems: [
      { product: 'Basket', soldAmount: 40, soldUnits: 2, paidOn: '2026-11-02' },
      { product: 'Wrap', soldAmount: 60, soldUnits: 1, paidOn: '2026-10-30' },
      { product: 'Basket', soldAmount: 0, soldUnits: 0, paidOn: null },
    ],
    payments: [
      {
        orderId: 'A',
        customer: 'Sarah',
        source: 'WhatsApp voice',
        gross: 50,
        refunded: 10,
        net: 40,
        pending: 0,
        paidOrders: 1,
        paidOn: '2026-11-02',
        status: 'Completed',
      },
      {
        orderId: 'B',
        customer: 'John',
        source: 'WhatsApp text',
        gross: 20,
        refunded: 20,
        net: 0,
        pending: 0,
        paidOrders: 0,
        paidOn: '2026-10-30',
        status: 'Refunded',
      },
      {
        orderId: 'C',
        customer: 'Grace',
        source: 'WhatsApp text',
        gross: 0,
        refunded: 0,
        net: 0,
        pending: 30,
        paidOrders: 0,
        paidOn: null,
        status: 'Awaiting buyer',
        createdAt: '2026-11-03T08:00:00Z',
      },
    ],
    products: [
      { product: 'Out', stockStatus: 'Out of stock', stock: 0, reorderLevel: 5, active: true },
      { product: 'Low', stockStatus: 'Low stock', stock: 2, reorderLevel: 5, active: true },
      { product: 'Fine', stockStatus: 'In stock', stock: 20, reorderLevel: 5, active: true },
      { product: 'Retired', stockStatus: 'Out of stock', stock: 0, reorderLevel: 5, active: false },
    ],
    disputes: [],
    shipments: [],
    customers: [],
  };
  const lookups = createLookups(shop, 'USD');

  it('lists exactly the unpaid requests, with their total', () => {
    expect(lookups.pendingPayments()).toMatchObject({
      count: 1,
      total: '$30.00',
      rows: [{ order: 'C', amount: '$30.00', status: 'Awaiting buyer', requested: '2026-11-03' }],
    });
  });

  it('lists paid orders to ship, oldest first', () => {
    const { count, rows } = lookups.ordersToShip();
    expect(count).toBe(2);
    expect(rows.map((r) => r.order)).toEqual(['B', 'A']);
  });

  it('flags only active products at risk, emptiest first', () => {
    expect(lookups.stockAlerts()).toMatchObject({
      outOfStock: 1,
      lowStock: 1,
      rows: [{ product: 'Out' }, { product: 'Low' }],
    });
  });

  it('ranks products by revenue, with share and units, ignoring unpaid lines', () => {
    expect(lookups.topProducts().rows).toEqual([
      { name: 'Wrap', amount: '$60.00', count: 1, sharePercent: 60 },
      { name: 'Basket', amount: '$40.00', count: 2, sharePercent: 40 },
    ]);
  });

  it('respects a date range using merchant-local dates', () => {
    expect(lookups.topProducts({ from: '2026-11-01' }).rows.map((r) => r.name)).toEqual(['Basket']);
    expect(lookups.salesBetween({ from: '2026-11-01', to: '2026-11-30' })).toMatchObject({
      grossSales: '$50.00',
      refunds: '$10.00',
      netRevenue: '$40.00',
      completedOrders: 1,
    });
  });

  it('leaves fully refunded sales out of revenue rankings', () => {
    expect(lookups.revenueByChannel().rows).toEqual([
      { name: 'WhatsApp voice', amount: '$40.00', count: 1, sharePercent: 100 },
    ]);
    expect(lookups.topCustomers().rows.map((r) => r.name)).toEqual(['Sarah']);
  });

  it('caps long lists and says so', () => {
    const many = createLookups(
      {
        ...shop,
        orders: Array.from({ length: 30 }, (_, i) => ({ orderId: `O${i}`, toShip: 'Yes' })),
      },
      'USD',
    ).ordersToShip();
    expect(many.count).toBe(30);
    expect(many.rows).toHaveLength(25);
    expect(many.note).toBe('Showing the first 25 of 30.');
  });
});

describe('assistant widget catalog', () => {
  const aiPage = (state: AgReportState) => state.pages?.find((p) => p.id === AI_PAGE_ID);

  it('builds charts from the revenue fields, on its own page, leaving standard pages alone', () => {
    const result = addChart(defaultReport, {
      metric: 'product_revenue',
      chart: 'bar',
      groupBy: 'product',
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.state.selectedPageId).toBe(AI_PAGE_ID);
    expect(result.state.pages?.slice(0, 3)).toEqual(defaultReport.pages);
    expect(aiPage(result.state)?.widgets?.[result.widgetId]).toMatchObject({
      type: 'bar-chart-grouped',
      dataMapping: {
        categoryKey: [{ id: 'orderItems.product' }],
        valueKey: [{ id: 'orderItems.soldAmount', aggregation: 'sum' }],
      },
    });
  });

  it('refuses groupings a metric cannot use, and tells the model which it can', () => {
    const result = addChart(defaultReport, {
      metric: 'stock_on_hand',
      chart: 'bar',
      groupBy: 'customer',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Stock on hand can be grouped by: product, category, stock_status.',
    });
    expect(addChart(defaultReport, { metric: 'net_revenue', chart: 'donut' }).ok).toBe(false);
    const byProduct = addChart(defaultReport, {
      metric: 'net_revenue',
      chart: 'bar',
      groupBy: 'product',
    });
    expect(byProduct).toMatchObject({
      ok: false,
      error: expect.stringContaining('product_revenue'),
    });
    expect(addChart(defaultReport, { metric: 'made_up' as never, chart: 'kpi' }).ok).toBe(false);
  });

  it('never labels a failed tool as done', () => {
    expect(toolLabel('add_chart', 'complete')).toBe('Added a chart to the AI dashboard');
    expect(toolLabel('add_chart', 'error')).toBe("Couldn't add that chart");
    expect(toolLabel('top_products', 'error')).toBe('Working on it');
  });

  it('never charts what has no time dimension over time', () => {
    expect(
      addChart(defaultReport, { metric: 'pending_payments', chart: 'line', groupBy: 'day' }).ok,
    ).toBe(false);
    const stock = addChart(defaultReport, {
      metric: 'stock_on_hand',
      chart: 'line',
      groupBy: 'product',
    });
    if (!stock.ok) throw new Error(stock.error);
    expect(aiPage(stock.state)?.widgets?.[stock.widgetId]).toMatchObject({
      type: 'bar-chart-grouped',
    });
  });

  it('keeps unpaid requests off time axes', () => {
    const result = addChart(defaultReport, {
      metric: 'net_revenue',
      chart: 'line',
      groupBy: 'day',
    });
    if (!result.ok) throw new Error(result.error);
    expect(aiPage(result.state)?.filter?.widget?.[result.widgetId]).toHaveLength(1);
  });

  it('lays widgets out in rows without overlap', () => {
    let state = defaultReport;
    const add = (spec: Parameters<typeof addChart>[1]) => {
      const result = addChart(state, spec);
      if (!result.ok) throw new Error(result.error);
      state = result.state;
    };
    add({ metric: 'net_revenue', chart: 'kpi' });
    add({ metric: 'refunds', chart: 'kpi' });
    add({ metric: 'net_revenue', chart: 'area', groupBy: 'day' });
    add({ metric: 'net_revenue', chart: 'donut', groupBy: 'channel' });
    const table = addTable(state, 'orders_to_ship');
    if (!table.ok) throw new Error(table.error);
    const boxes = Object.values(
      aiPage(table.state)?.widgetLayout as Record<
        string,
        { xTrack: number; yTrack: number; xSpan: number; ySpan: number }
      >,
    );
    expect(boxes.map((b) => [b.xTrack, b.yTrack])).toEqual([
      [0, 0],
      [4, 0],
      [0, 6],
      [12, 6],
      [0, 20],
    ]);
    expect(boxes.every((b) => b.xTrack + b.xSpan <= 24)).toBe(true);
  });

  it('filters worklists to the records they name', () => {
    const result = addTable(defaultReport, 'pending_payments');
    if (!result.ok) throw new Error(result.error);
    expect(aiPage(result.state)?.filter?.widget?.[result.widgetId]).toMatchObject([
      { field: { id: 'orders.status' }, model: { operator: 'equals', value: 'Awaiting payment' } },
    ]);
  });
});

describe('drill-through', () => {
  const product = {
    field: { id: 'orderItems.product' },
    operator: 'equals',
    value: 'Basket',
  } as never;
  const stock = {
    field: { id: 'products.stockStatus' },
    operator: 'equals',
    value: 'Low stock',
  } as never;
  const fields = (state: AgReportState) => JSON.stringify(state.pages?.[0]?.widgets);

  it('shows sales records for sales, and products for products, which sales are not joined to', () => {
    expect(fields(drillReport(product))).toContain('payments.net');
    expect(fields(drillReport(product))).toContain('orderItems.soldAmount');
    expect(fields(drillReport(stock))).toContain('products.stockStatus');
    expect(fields(drillReport(stock))).not.toContain('payments.');
  });

  it('keeps whatever was already narrowing the widget', () => {
    expect(drillFilter(product)).toBe(product);
    expect(drillFilter(product, { page: stock })).toEqual({
      operator: 'AND',
      conditions: [product, stock],
    });
  });

  it('names the clicked values', () => {
    expect(describeDrill(product)).toBe('Basket');
    expect(describeDrill({ operator: 'AND', conditions: [product, stock] } as never)).toBe(
      'Basket, Low stock',
    );
  });
});
