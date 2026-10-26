'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { ColDef } from 'ag-grid-community';
import { CommerceGrid, formatDate, formatMinor } from '@/components/grid/commerce-grid';
import { InputModePill, StatusPill } from '@/components/ui-client';
import type { Order } from '@/lib/types';
import { toMajorNumber } from '@vca/commerce/money';
import { cancelOrder } from './actions';

const CANCEL_REASONS: Record<NonNullable<Order['cancelReason']>, string> = {
  PAYMENT_EXPIRED: 'not paid in time',
  MERCHANT: 'by the shop',
  CUSTOMER: 'by the customer',
};

/** Orders that can still be cancelled: nothing has been paid. */
const cancellable = (o: Order) => o.status === 'DRAFT' || o.status === 'AWAITING_PAYMENT';

interface OrderRow {
  id: string;
  reference: string;
  customer: string;
  channel: string;
  inputMode: 'TEXT' | 'VOICE';
  items: string;
  amount: number;
  totalMinor: number;
  currency: string;
  status: Order['status'];
  paymentStatus: string;
  fulfillment: string;
  createdAt: Date;
  order: Order;
}

const CHANNELS: Record<string, string> = { whatsapp: 'WhatsApp', web: 'Agent console' };

export function OrdersGrid({ orders }: { orders: Order[] }) {
  const [selected, setSelected] = useState<Order | null>(null);
  const rows = useMemo<OrderRow[]>(
    () =>
      orders.map((o) => ({
        id: o.id,
        reference: o.reference,
        customer: o.customer.name,
        channel: CHANNELS[o.source] ?? o.source,
        inputMode: o.inputMode,
        items: (o.items ?? []).map((i) => `${i.quantity} × ${i.description}`).join(', '),
        amount: toMajorNumber(o.totalMinor, o.currency),
        totalMinor: o.totalMinor,
        currency: o.currency,
        status: o.status,
        paymentStatus: o.payments?.[0]?.status ?? '',
        fulfillment: (o.disputes ?? []).some((d) => d.status !== 'RESOLVED')
          ? 'Disputed'
          : o.fulfillmentStatus === 'SHIPPED'
            ? 'Shipped'
            : o.status === 'PAID'
              ? 'To ship'
              : '',
        createdAt: new Date(o.createdAt),
        order: o,
      })),
    [orders],
  );

  const columns = useMemo<ColDef<OrderRow>[]>(
    () => [
      {
        field: 'reference',
        headerName: 'Order',
        pinned: 'left',
        minWidth: 120,
        cellClass: 'font-medium',
      },
      { field: 'customer', headerName: 'Customer', minWidth: 150 },
      { field: 'channel', headerName: 'Channel', minWidth: 110 },
      {
        field: 'inputMode',
        headerName: 'Source',
        minWidth: 100,
        cellRenderer: (p: { value?: 'TEXT' | 'VOICE' }) =>
          p.value ? <InputModePill mode={p.value} /> : null,
      },
      { field: 'items', headerName: 'Items', minWidth: 160, flex: 2, tooltipField: 'items' },
      {
        field: 'amount',
        headerName: 'Amount',
        type: 'rightAligned',
        filter: 'agNumberColumnFilter',
        minWidth: 110,
        valueFormatter: (p) => formatMinor(p.data?.totalMinor, p.data?.currency),
        cellClass: 'tabular-nums font-medium',
      },
      { field: 'currency', headerName: 'Currency', minWidth: 80, maxWidth: 100 },
      {
        field: 'paymentStatus',
        headerName: 'Payment',
        minWidth: 130,
        cellRenderer: (p: { value?: string; node: { rowPinned?: string | null } }) =>
          p.node.rowPinned ? null : p.value ? (
            <StatusPill status={p.value} kind="payment" />
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        field: 'status',
        headerName: 'Order status',
        minWidth: 150,
        cellRenderer: (p: { value?: string; node: { rowPinned?: string | null } }) =>
          p.value && !p.node.rowPinned ? <StatusPill status={p.value} /> : null,
      },
      {
        field: 'fulfillment',
        headerName: 'Fulfillment',
        minWidth: 120,
        cellRenderer: (p: { value?: string; node: { rowPinned?: string | null } }) =>
          p.node.rowPinned || !p.value ? null : (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-5 ring-1 ring-inset ${
                p.value === 'Shipped'
                  ? 'bg-teal-50 text-teal-700 ring-teal-600/20'
                  : p.value === 'Disputed'
                    ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                    : 'bg-amber-50 text-amber-800 ring-amber-600/20'
              }`}
            >
              {p.value}
            </span>
          ),
      },
      {
        field: 'createdAt',
        headerName: 'Created',
        filter: 'agDateColumnFilter',
        sort: 'desc',
        minWidth: 160,
        valueFormatter: (p) => (p.node?.rowPinned ? '' : formatDate(p.value)),
      },
    ],
    [],
  );

  return (
    <>
      <CommerceGrid<OrderRow>
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        statusField="status"
        statusOptions={[
          { label: 'Awaiting payment', value: 'AWAITING_PAYMENT' },
          { label: 'Paid', value: 'PAID' },
          { label: 'Draft', value: 'DRAFT' },
          { label: 'Cancelled', value: 'CANCELLED' },
          { label: 'Refunded', value: 'REFUNDED' },
        ]}
        summarize={(visible) => {
          // Money in hand only: paid orders, net of partial refunds (not drafts or cancelled).
          const paid = visible.filter((r) => r.status === 'PAID');
          const currencies = [...new Set(paid.map((r) => r.currency))];
          const one = currencies.length === 1 ? currencies[0]! : '';
          return {
            reference: `${visible.length} orders`,
            items: paid.length ? `${paid.length} paid · total net of refunds` : '',
            totalMinor: one
              ? paid.reduce((sum, r) => sum + r.totalMinor - (r.order.refundedMinor ?? 0), 0)
              : undefined,
            currency: one,
          } as Partial<OrderRow>;
        }}
        onRowClick={(row) => setSelected(row.order)}
        exportName="katale-orders"
        searchPlaceholder="Search orders, customers, items…"
        emptyMessage="No orders yet. Send Katale AI an order on WhatsApp or in the Agent console."
      />
      {selected && <OrderDetail order={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function CancelOrderButton({ order, onDone }: { order: Order; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="mt-6 rounded-lg border border-slate-200 p-3">
      <p className="text-sm text-slate-600">
        Not paid yet. Cancelling releases its reserved stock and stops the PayPal link from working
        {order.placedBy === 'CUSTOMER' ? '; the customer is told on WhatsApp' : ''}.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Cancel order ${order.reference}? This can't be undone.`)) return;
          start(async () => {
            const result = await cancelOrder(order.reference);
            setMessage({ ok: result.ok, text: result.message });
            router.refresh();
            if (result.ok) onDone();
          });
        }}
        className="mt-2 rounded-md border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {pending ? 'Cancelling…' : 'Cancel order'}
      </button>
      {message && (
        <p
          role="status"
          className={`mt-2 text-sm ${message.ok ? 'text-emerald-700' : 'text-rose-700'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function OrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  const m = (minor: number) => formatMinor(minor, order.currency);
  const payment = order.payments?.[0];
  const refunded = order.refundedMinor ?? 0;
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`Order ${order.reference}`}
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/20"
        onClick={onClose}
      />
      <aside className="relative h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Order</p>
            <h2 className="text-xl font-semibold text-slate-900">{order.reference}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {order.customer.name} · {formatDate(order.createdAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusPill status={order.status} />
          <InputModePill mode={order.inputMode} />
          <span className="inline-flex rounded-full bg-white px-2 py-0.5 text-xs font-medium leading-5 text-slate-600 ring-1 ring-inset ring-slate-200">
            {CHANNELS[order.source] ?? order.source}
          </span>
        </div>

        {order.status === 'CANCELLED' && (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Cancelled
            {order.cancelReason ? ` ${CANCEL_REASONS[order.cancelReason]}` : ''}
            {order.cancelledAt ? ` · ${formatDate(order.cancelledAt)}` : ''}. No money was taken.
          </p>
        )}
        {cancellable(order) && order.paymentDueAt && (
          <p className="mt-4 text-sm text-slate-600">
            Payment due by <strong>{formatDate(order.paymentDueAt)}</strong>; cancelled
            automatically if unpaid.
          </p>
        )}

        <h3 className="mt-6 text-sm font-semibold text-slate-700">Customer</h3>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Name</dt>
            <dd className="text-right">{order.contactName ?? order.customer.name}</dd>
          </div>
          {order.customer.phone && (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Phone</dt>
              <dd className="text-right">{order.customer.phone}</dd>
            </div>
          )}
          {order.deliveryMethod && (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Delivery</dt>
              <dd className="text-right">
                {order.deliveryMethod === 'PICKUP'
                  ? 'Pick up'
                  : `Deliver to ${order.deliveryAddress ?? '(no address)'}`}
              </dd>
            </div>
          )}
          {order.notes && (
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Notes</dt>
              <dd className="text-right">{order.notes}</dd>
            </div>
          )}
        </dl>

        <h3 className="mt-6 text-sm font-semibold text-slate-700">Items</h3>
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {(order.items ?? []).map((i) => (
            <li key={i.id} className="flex justify-between gap-4 px-3 py-2">
              <span>
                {i.quantity} × {i.description}
                {i.quantity > 1 && <span className="text-slate-500"> @ {m(i.unitPriceMinor)}</span>}
                {!i.productId && (
                  <span className="ml-1 text-xs text-amber-700">(not in catalog)</span>
                )}
              </span>
              <span className="tabular-nums">{m(i.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 text-sm">
          {order.shippingMinor > 0 && (
            <div className="flex justify-between text-slate-600">
              <dt>Shipping</dt>
              <dd className="tabular-nums">{m(order.shippingMinor)}</dd>
            </div>
          )}
          {order.taxMinor > 0 && (
            <div className="flex justify-between text-slate-600">
              <dt>Tax</dt>
              <dd className="tabular-nums">{m(order.taxMinor)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-2 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{m(order.totalMinor)}</dd>
          </div>
          {refunded > 0 && (
            <div className="flex justify-between text-rose-700">
              <dt>{refunded >= order.totalMinor ? 'Refunded (full)' : 'Refunded (partial)'}</dt>
              <dd className="tabular-nums">−{m(refunded)}</dd>
            </div>
          )}
        </dl>
        <p className="mt-2 text-xs text-slate-500">
          Calculated by the backend from catalog prices and the merchant&apos;s stated prices —
          never by the AI.
        </p>

        <h3 className="mt-6 text-sm font-semibold text-slate-700">Payment</h3>
        {payment ? (
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Status</dt>
              <dd>
                <StatusPill status={payment.status} kind="payment" />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Provider</dt>
              <dd>
                PayPal
                {payment.providerStatus
                  ? ` · ${payment.providerStatus.toLowerCase().replace(/_/g, ' ')}`
                  : ''}
              </dd>
            </div>
            {payment.completedAt && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Paid</dt>
                <dd>{formatDate(payment.completedAt)}</dd>
              </div>
            )}
            {payment.checkoutUrl && payment.status !== 'COMPLETED' && (
              <div className="flex justify-between">
                <dt className="text-slate-600">Checkout</dt>
                <dd>
                  <a
                    className="text-sky-700 hover:underline"
                    href={payment.checkoutUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PayPal link
                  </a>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            {order.status === 'DRAFT'
              ? 'Waiting for the merchant to confirm (CONFIRM code).'
              : 'No payment request.'}
          </p>
        )}
        <h3 className="mt-6 text-sm font-semibold text-slate-700">Fulfillment</h3>
        {(order.shipments ?? []).length ? (
          <ul className="mt-2 space-y-2 text-sm">
            {(order.shipments ?? []).map((sh) => (
              <li key={sh.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">
                    {sh.carrier === 'OTHER' ? (sh.carrierNameOther ?? 'Other carrier') : sh.carrier}
                  </span>
                  <span className="font-mono text-xs text-slate-700">{sh.trackingNumber}</span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {sh.status === 'SHIPPED' ? 'Shipped' : 'Cancelled'} {formatDate(sh.shippedAt)}
                  {' · '}
                  {sh.providerTrackerId
                    ? 'Tracking registered with PayPal'
                    : 'Not synced with PayPal'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            Not shipped
            {order.status === 'PAID'
              ? ' — tell Katale AI the carrier and tracking number to add it.'
              : '.'}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          PayPal tracking has no delivery status, so Katale doesn&apos;t show one.
        </p>
        {(order.disputes ?? []).length > 0 && (
          <Link
            href="/disputes"
            className="mt-3 inline-flex text-sm font-medium text-rose-700 hover:underline"
          >
            This order has a PayPal dispute →
          </Link>
        )}

        {cancellable(order) && <CancelOrderButton order={order} onDone={onClose} />}

        {payment?.correlationId && (
          <Link
            href={`/activity?trace=${encodeURIComponent(payment.correlationId)}`}
            className="mt-6 inline-flex rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            View the full trace →
          </Link>
        )}
      </aside>
    </div>
  );
}
