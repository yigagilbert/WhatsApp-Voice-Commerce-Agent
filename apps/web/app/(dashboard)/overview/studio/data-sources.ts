import type { AgDataSourcesDefinition } from 'ag-studio';
import type { AnalyticsDataset } from '@/lib/types';

const ofCurrency = <T extends Record<string, unknown>>(rows: T[], currency: string) =>
  rows.filter((row) => row.currency === currency);

/**
 * One currency's rows. AG Studio can sum any field it is given, so amounts in different currencies
 * must never reach it together: with one currency loaded at a time, no chart, filter or AI query
 * can add dollars to shillings. Merchants with several currencies switch between them.
 */
export function scopeDataset(dataset: AnalyticsDataset, currency: string): AnalyticsDataset {
  const orders = ofCurrency(dataset.orders, currency);
  const references = new Set(orders.map((o) => o.orderId));
  return {
    ...dataset,
    orders,
    orderItems: ofCurrency(dataset.orderItems, currency),
    payments: ofCurrency(dataset.payments, currency),
    disputes: ofCurrency(dataset.disputes, currency),
    products: ofCurrency(dataset.products, currency),
    shipments: dataset.shipments.filter((s) => references.has(s.orderId)),
  };
}

/** AG Studio's tables, with descriptions that tell both people and the assistant what each means. */
export function buildDataSources(
  dataset: AnalyticsDataset,
  currency: string,
): AgDataSourcesDefinition {
  const money = {
    format: 'currencyFormat',
    formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency }) },
  } as const;
  return {
    description: `Katale AI commerce records for one merchant, in ${currency} only. Dates ending "On" are calendar dates in the merchant's timezone (${dataset.meta.timezone}). For revenue use the Payments table: sum Net revenue. Sale amounts are already zero on rows that are not sales.`,
    sources: [
      {
        id: 'payments',
        name: 'Payments',
        description:
          'PayPal payment requests. The source of truth for revenue: Net revenue is what the merchant keeps after refunds. Duplicate payments and unpaid requests have zero Gross, Refunds and Net.',
        data: dataset.payments,
        fields: [
          { id: 'paymentId', name: 'Payment ID', format: 'textFormat', hide: true },
          { id: 'orderId', name: 'Order', format: 'textFormat' },
          { id: 'customerId', name: 'Customer ID', format: 'textFormat', hide: true },
          { id: 'customer', name: 'Customer', format: 'textFormat' },
          {
            id: 'source',
            name: 'Channel',
            format: 'textFormat',
            description: 'WhatsApp voice, WhatsApp text, website or Agent console',
          },
          { id: 'provider', name: 'Provider', format: 'textFormat', hide: true },
          { id: 'status', name: 'Payment status', format: 'textFormat' },
          {
            id: 'amount',
            name: 'Amount requested',
            ...money,
            description: 'The request amount, paid or not. Do not use for revenue.',
          },
          {
            id: 'gross',
            name: 'Gross sales',
            ...money,
            description: 'Captured sales before refunds.',
          },
          { id: 'refunded', name: 'Refunds', ...money, description: 'Refunded on those sales.' },
          { id: 'net', name: 'Net revenue', ...money, description: 'Gross sales minus refunds.' },
          {
            id: 'pending',
            name: 'Pending amount',
            ...money,
            description: 'Sent to the customer and not paid yet.',
          },
          {
            id: 'paidOrders',
            name: 'Completed orders',
            format: 'integerFormat',
            description:
              '1 for a sale that was not fully refunded. Sum it to count completed orders.',
          },
          { id: 'duplicate', name: 'Duplicate payment', format: 'textFormat' },
          { id: 'currency', name: 'Currency', format: 'textFormat' },
          { id: 'createdAt', name: 'Requested', format: 'dateTimeFormat' },
          { id: 'completedAt', name: 'Completed', format: 'dateTimeFormat' },
          { id: 'paidOn', name: 'Paid on', format: 'dateFormat' },
        ],
      },
      {
        id: 'orders',
        name: 'Orders',
        description:
          'One row per order. Status: Draft, Awaiting payment, Paid, Cancelled or Refunded. To ship = Yes means paid and not shipped.',
        data: dataset.orders,
        fields: [
          { id: 'orderId', name: 'Order', format: 'textFormat' },
          { id: 'customerId', name: 'Customer ID', format: 'textFormat', hide: true },
          { id: 'customer', name: 'Customer', format: 'textFormat' },
          {
            id: 'channel',
            name: 'Sales channel',
            format: 'textFormat',
            description: 'WhatsApp or Agent console',
          },
          {
            id: 'inputMode',
            name: 'Input',
            format: 'textFormat',
            description: 'Voice note or Text',
          },
          {
            id: 'source',
            name: 'Source',
            format: 'textFormat',
            description: 'WhatsApp voice, WhatsApp text, website or Agent console',
          },
          { id: 'status', name: 'Order status', format: 'textFormat' },
          { id: 'currency', name: 'Currency', format: 'textFormat' },
          { id: 'subtotal', name: 'Subtotal', ...money },
          { id: 'shipping', name: 'Shipping', ...money },
          {
            id: 'total',
            name: 'Order total',
            ...money,
            description: 'Before refunds, paid or not. Do not sum for revenue.',
          },
          { id: 'refunded', name: 'Refunded', ...money },
          {
            id: 'net',
            name: 'Net of refunds',
            ...money,
            description: 'Zero unless the order is paid.',
          },
          { id: 'itemCount', name: 'Units', format: 'integerFormat' },
          { id: 'createdAt', name: 'Created', format: 'dateTimeFormat' },
          { id: 'createdOn', name: 'Created on', format: 'dateFormat' },
          { id: 'paidAt', name: 'Paid at', format: 'dateTimeFormat' },
          { id: 'paidOn', name: 'Order paid on', format: 'dateFormat' },
          {
            id: 'fulfillment',
            name: 'Fulfillment',
            format: 'textFormat',
            description: 'Shipped or Not shipped',
          },
          {
            id: 'toShip',
            name: 'To ship',
            format: 'textFormat',
            description: 'Yes = paid and not shipped yet',
          },
          { id: 'attention', name: 'Needs review', format: 'textFormat', hide: true },
        ],
      },
      {
        id: 'orderItems',
        name: 'Order items',
        description:
          'One row per order line. Sold amount and Sold units are zero unless the order is paid. They exclude shipping, and partial refunds are not split across lines.',
        data: dataset.orderItems,
        fields: [
          { id: 'itemId', name: 'Item ID', format: 'textFormat', hide: true },
          { id: 'orderId', name: 'Order', format: 'textFormat' },
          { id: 'product', name: 'Product', format: 'textFormat' },
          { id: 'inCatalog', name: 'In catalog', format: 'booleanFormat' },
          { id: 'quantity', name: 'Quantity', format: 'integerFormat' },
          { id: 'unitPrice', name: 'Unit price', ...money },
          {
            id: 'lineTotal',
            name: 'Line total',
            ...money,
            description: 'Paid or not. Use Sold amount for product revenue.',
          },
          { id: 'soldUnits', name: 'Sold units', format: 'integerFormat' },
          { id: 'soldAmount', name: 'Sold amount', ...money },
          { id: 'orderStatus', name: 'Status of order', format: 'textFormat' },
          { id: 'currency', name: 'Currency', format: 'textFormat', hide: true },
          { id: 'source', name: 'Channel', format: 'textFormat' },
          { id: 'paidOn', name: 'Sold on', format: 'dateFormat' },
        ],
      },
      {
        id: 'products',
        name: 'Products',
        description:
          'The catalog with current stock. Stock status: In stock, Low stock, Out of stock or Not tracked.',
        data: dataset.products,
        fields: [
          { id: 'sku', name: 'SKU', format: 'textFormat' },
          { id: 'product', name: 'Catalog product', format: 'textFormat' },
          { id: 'category', name: 'Category', format: 'textFormat' },
          { id: 'price', name: 'Price', ...money },
          { id: 'currency', name: 'Currency', format: 'textFormat', hide: true },
          { id: 'stock', name: 'Stock', format: 'integerFormat' },
          { id: 'reorderLevel', name: 'Reorder level', format: 'integerFormat' },
          { id: 'stockStatus', name: 'Stock status', format: 'textFormat' },
          { id: 'active', name: 'Active', format: 'booleanFormat' },
          { id: 'unitsSold', name: 'Units sold', format: 'integerFormat' },
          {
            id: 'revenue',
            name: 'Product revenue',
            ...money,
            description: 'Line totals of paid orders, excluding shipping.',
          },
        ],
      },
      {
        id: 'shipments',
        name: 'Shipments',
        description: 'Tracking numbers added to paid orders.',
        data: dataset.shipments,
        fields: [
          { id: 'shipmentId', name: 'Shipment ID', format: 'textFormat', hide: true },
          { id: 'orderId', name: 'Order', format: 'textFormat' },
          { id: 'carrier', name: 'Carrier', format: 'textFormat' },
          { id: 'trackingNumber', name: 'Tracking number', format: 'textFormat' },
          { id: 'status', name: 'Shipment status', format: 'textFormat' },
          { id: 'shippedAt', name: 'Shipped at', format: 'dateTimeFormat' },
        ],
      },
      {
        id: 'disputes',
        name: 'Disputes',
        description: 'PayPal disputes. Active = Yes means not resolved yet.',
        data: dataset.disputes,
        fields: [
          { id: 'disputeId', name: 'Dispute', format: 'textFormat' },
          { id: 'orderId', name: 'Order', format: 'textFormat' },
          { id: 'reason', name: 'Dispute reason', format: 'textFormat' },
          { id: 'status', name: 'Dispute status', format: 'textFormat' },
          { id: 'active', name: 'Active', format: 'textFormat' },
          { id: 'amount', name: 'Disputed amount', ...money },
          { id: 'currency', name: 'Currency', format: 'textFormat', hide: true },
          { id: 'openedAt', name: 'Opened', format: 'dateTimeFormat' },
          { id: 'responseDue', name: 'Response due', format: 'dateTimeFormat' },
        ],
      },
      {
        id: 'customers',
        name: 'Customers',
        data: dataset.customers,
        fields: [
          { id: 'customerId', name: 'Customer ID', format: 'textFormat', hide: true },
          { id: 'name', name: 'Customer name', format: 'textFormat' },
          { id: 'country', name: 'Country', format: 'textFormat' },
          { id: 'createdAt', name: 'Customer since', format: 'dateTimeFormat' },
        ],
      },
    ],
    relationships: [
      {
        id: 'order-shipments',
        source: { tableId: 'orders', fieldId: 'orderId' },
        target: { tableId: 'shipments', fieldId: 'orderId' },
        type: 'one-to-many',
      },
      {
        id: 'order-disputes',
        source: { tableId: 'orders', fieldId: 'orderId' },
        target: { tableId: 'disputes', fieldId: 'orderId' },
        type: 'one-to-many',
      },
      {
        id: 'order-items',
        source: { tableId: 'orders', fieldId: 'orderId' },
        target: { tableId: 'orderItems', fieldId: 'orderId' },
        type: 'one-to-many',
      },
      {
        id: 'order-payments',
        source: { tableId: 'orders', fieldId: 'orderId' },
        target: { tableId: 'payments', fieldId: 'orderId' },
        type: 'one-to-many',
      },
      {
        id: 'customer-orders',
        source: { tableId: 'customers', fieldId: 'customerId' },
        target: { tableId: 'orders', fieldId: 'customerId' },
        type: 'one-to-many',
      },
    ],
  };
}
