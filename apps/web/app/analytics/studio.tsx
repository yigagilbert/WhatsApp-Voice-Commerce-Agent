'use client';

import { useMemo } from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { AgStudioAiModule, createAiHarness, type AgDataSourcesDefinition } from 'ag-studio';
import type { AnalyticsDataset } from '@/lib/types';
import { defaultReport } from './default-report';
import { kataleProxyAdapter } from './studio-adapter';

/**
 * AG Studio over Katale's trusted commerce data: orders, line items, PayPal payments,
 * customers and products, joined by relationships. Its assistant answers questions like
 * "Show paid WhatsApp voice orders this week" by calling AG Studio's own structured tools
 * (inspect schema, run a query, add a widget) — it never writes code or touches payments.
 */
export function AnalyticsStudio({
  dataset,
  licenseKey,
  aiEnabled,
}: {
  dataset: AnalyticsDataset;
  licenseKey?: string | undefined;
  aiEnabled: boolean;
}) {
  const data = useMemo<AgDataSourcesDefinition>(() => {
    const currency = String(dataset.orders[0]?.currency ?? dataset.products[0]?.currency ?? 'USD');
    const money = {
      format: 'currencyFormat',
      formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency }) },
    } as const;
    return {
      description:
        'Katale AI conversational-commerce data for one merchant. Orders come from WhatsApp (text or voice notes) or the Agent console. Revenue means completed PayPal payments. Amounts are in the order currency (USD).',
      sources: [
        {
          id: 'orders',
          name: 'Orders',
          description: 'One row per order. status: Draft, Awaiting payment, Paid, Cancelled.',
          data: dataset.orders,
          fields: [
            { id: 'orderId', name: 'Order', format: 'textFormat' },
            { id: 'customerId', name: 'Customer ID', format: 'textFormat', hide: true },
            { id: 'customer', name: 'Customer', format: 'textFormat' },
            {
              id: 'channel',
              name: 'Channel',
              format: 'textFormat',
              description: 'WhatsApp or Agent console',
            },
            {
              id: 'inputMode',
              name: 'Input',
              format: 'textFormat',
              description: 'Voice (voice note) or Text',
            },
            {
              id: 'source',
              name: 'Source',
              format: 'textFormat',
              description: 'WhatsApp voice, WhatsApp text or Agent console',
            },
            { id: 'status', name: 'Status', format: 'textFormat' },
            { id: 'currency', name: 'Currency', format: 'textFormat' },
            { id: 'subtotal', name: 'Subtotal', ...money },
            { id: 'shipping', name: 'Shipping', ...money },
            { id: 'total', name: 'Order total', ...money },
            { id: 'itemCount', name: 'Units', format: 'integerFormat' },
            { id: 'createdAt', name: 'Created', format: 'dateTimeFormat' },
            { id: 'paidAt', name: 'Paid at', format: 'dateTimeFormat' },
            {
              id: 'fulfillment',
              name: 'Fulfillment',
              format: 'textFormat',
              description: 'Shipped or Not shipped (tracking added at PayPal)',
            },
          ],
        },
        {
          id: 'orderItems',
          name: 'Order items',
          description: 'One row per order line. lineTotal excludes shipping.',
          data: dataset.orderItems,
          fields: [
            { id: 'itemId', name: 'Item ID', format: 'textFormat', hide: true },
            { id: 'orderId', name: 'Order', format: 'textFormat' },
            { id: 'product', name: 'Product', format: 'textFormat' },
            { id: 'inCatalog', name: 'In catalog', format: 'booleanFormat' },
            { id: 'quantity', name: 'Quantity', format: 'integerFormat' },
            { id: 'unitPrice', name: 'Unit price', ...money },
            { id: 'lineTotal', name: 'Line total', ...money },
            { id: 'orderStatus', name: 'Order status', format: 'textFormat' },
          ],
        },
        {
          id: 'payments',
          name: 'Payments',
          description: 'PayPal payment requests. status Completed = money received.',
          data: dataset.payments,
          fields: [
            { id: 'paymentId', name: 'Payment ID', format: 'textFormat', hide: true },
            { id: 'orderId', name: 'Order', format: 'textFormat' },
            { id: 'customerId', name: 'Customer ID', format: 'textFormat', hide: true },
            { id: 'provider', name: 'Provider', format: 'textFormat' },
            { id: 'status', name: 'Payment status', format: 'textFormat' },
            { id: 'amount', name: 'Amount', ...money },
            { id: 'currency', name: 'Currency', format: 'textFormat' },
            { id: 'createdAt', name: 'Requested', format: 'dateTimeFormat' },
            { id: 'completedAt', name: 'Completed', format: 'dateTimeFormat' },
          ],
        },
        {
          id: 'shipments',
          name: 'Shipments',
          description: 'Tracking numbers added to paid orders (registered with PayPal).',
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
          description:
            'PayPal disputes. status uses PayPal values: OPEN, WAITING_FOR_SELLER_RESPONSE, WAITING_FOR_BUYER_RESPONSE, UNDER_REVIEW, RESOLVED.',
          data: dataset.disputes,
          fields: [
            { id: 'disputeId', name: 'Dispute', format: 'textFormat' },
            { id: 'orderId', name: 'Order', format: 'textFormat' },
            { id: 'reason', name: 'Dispute reason', format: 'textFormat' },
            { id: 'status', name: 'Dispute status', format: 'textFormat' },
            { id: 'amount', name: 'Disputed amount', ...money },
            { id: 'currency', name: 'Currency', format: 'textFormat' },
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
        {
          id: 'products',
          name: 'Products',
          description: 'The catalog.',
          data: dataset.products,
          fields: [
            { id: 'sku', name: 'SKU', format: 'textFormat' },
            { id: 'product', name: 'Catalog product', format: 'textFormat' },
            { id: 'price', name: 'Price', ...money },
            { id: 'currency', name: 'Currency', format: 'textFormat' },
            { id: 'stock', name: 'Stock', format: 'integerFormat' },
            { id: 'active', name: 'Active', format: 'booleanFormat' },
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
  }, [dataset]);

  return (
    <div className="h-[calc(100vh-11rem)] min-h-[560px] w-full overflow-hidden rounded-lg border border-slate-200 bg-white">
      <AgStudioProvider
        modules={aiEnabled ? [AgStudioAiModule] : []}
        {...(licenseKey ? { licenseKey } : {})}
      >
        <AgStudio
          data={data}
          mode="edit"
          initialState={defaultReport}
          {...(aiEnabled
            ? {
                ai: ({ api }) =>
                  createAiHarness(api, {
                    adapter: kataleProxyAdapter,
                    promptStarters: [
                      {
                        label: 'Voice vs text revenue',
                        prompt: 'Add a bar chart of order total for Paid orders by Source.',
                      },
                      {
                        label: 'Best-selling products',
                        prompt: 'Show line total by product for paid orders, highest first.',
                      },
                      {
                        label: 'Unpaid orders',
                        prompt:
                          'Add a table of orders with status Awaiting payment: order, customer, total, created.',
                      },
                      {
                        label: 'Paid orders not shipped',
                        prompt:
                          'Show a table of orders with Status Paid and Fulfillment Not shipped.',
                      },
                      {
                        label: 'Disputed amount',
                        prompt:
                          'Add a KPI of total dispute amount for disputes whose status is not RESOLVED, and a table of those disputes.',
                      },
                      {
                        label: 'Paid voice orders this week',
                        prompt: 'Show paid WhatsApp voice orders from this week as a table.',
                      },
                    ],
                  }),
              }
            : {})}
        />
      </AgStudioProvider>
    </div>
  );
}
