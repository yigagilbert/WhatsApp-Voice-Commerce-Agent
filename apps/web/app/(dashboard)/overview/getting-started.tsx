import Link from 'next/link';
import { ErrorNotice } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { buildSetup, type SetupStep } from '@/lib/setup-checklist';
import type { DashboardSummary, ProductStat, StorefrontSettings } from '@/lib/types';
import type { ShopView } from '../whatsapp/shop-settings';

/**
 * Setup checklist on the overview: everything between an empty shop and a first paid order. It says
 * "ready to sell" only when a customer's order could really go through, and goes away once a paid
 * order shows it did. A status that can't be read counts as not done.
 */
export async function GettingStarted({ summary }: { summary: DashboardSummary }) {
  const [session, admins, products, shop, storefront, health] = await Promise.all([
    apiGet<{ state: string }>('/api/whatsapp/session'),
    apiGet<{ active: boolean }[]>('/api/admins'),
    apiGet<ProductStat[]>('/api/products/stats'),
    apiGet<ShopView>('/api/whatsapp/account'),
    apiGet<StorefrontSettings>('/api/storefront'),
    apiGet<{ providers?: { paypal?: string } }>('/api/health/ready'),
  ]);
  const account = shop.ok
    ? (shop.data.accounts.find((a) => a.active) ?? shop.data.accounts[0])
    : undefined;
  const paypal = health.ok ? health.data.providers?.paypal : undefined;
  const setup = buildSetup({
    whatsappLinked: session.ok && session.data.state === 'ready',
    hasActiveAdmin: admins.ok && admins.data.some((a) => a.active),
    hasProductWithPhoto: products.ok && products.data.some((p) => p.active && !!p.imageVersion),
    customerShoppingAvailable: !shop.ok || shop.data.available,
    customerShoppingOn: !!account?.customerCommerceEnabled,
    fulfilmentOn: !!account && (account.deliveryEnabled || account.pickupEnabled),
    storefrontPublished: storefront.ok && storefront.data.enabled,
    checkoutBlocker: storefront.ok ? storefront.data.checkoutBlocker : null,
    paypalConfigured: paypal === undefined ? null : paypal !== 'not_configured',
    currency: summary.merchant.preferredCurrency,
    orders: summary.counts.orders,
    paidOrders: summary.counts.paidOrders,
  });
  const { steps, blockers, ready, remaining } = setup;
  if (remaining === 0 && blockers.length === 0) return null;
  // A shop that is already selling shouldn't have to scroll past its setup to see its business.
  const open = summary.counts.paidOrders === 0;

  return (
    <>
      {blockers.map((blocker) => (
        <div key={blocker} className="mb-3">
          <ErrorNotice message={blocker} />
        </div>
      ))}
      {remaining > 0 && (
        <details
          open={open}
          className="mb-5 rounded-2xl border border-mist bg-white px-4 py-3 text-sm [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-2">
            <span
              id="getting-started"
              className={ready ? 'font-medium text-emerald-700' : 'font-medium text-charcoal'}
            >
              {ready ? 'Ready to sell' : 'Finish setting up'}
            </span>
            <span className="text-xs text-slate-500">
              {steps.length - remaining} of {steps.length} done
            </span>
          </summary>
          {ready ? (
            <p className="mt-2 text-sm text-slate-600">
              Customers can browse, order and pay. What&apos;s left is your first sale.
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-600">
              Customers can&apos;t buy from you yet. These steps get you there.
            </p>
          )}
          <Steps steps={steps} />
        </details>
      )}
    </>
  );
}

function Steps({ steps }: { steps: SetupStep[] }) {
  return (
    <section aria-labelledby="getting-started">
      <ol className="mt-2 divide-y divide-slate-100">
        {steps.map((step) => (
          <li key={step.title} className="flex items-center gap-3 py-2.5 text-sm">
            <span
              aria-hidden="true"
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                step.done ? 'bg-emerald-600 text-white' : 'border border-slate-300 text-transparent'
              }`}
            >
              ✓
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={step.done ? 'text-slate-500 line-through' : 'font-medium text-slate-900'}
              >
                {step.title}
                <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
              </p>
              {!step.done && <p className="text-xs text-slate-500">{step.detail}</p>}
            </div>
            {!step.done && (
              <Link
                href={step.href}
                className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
