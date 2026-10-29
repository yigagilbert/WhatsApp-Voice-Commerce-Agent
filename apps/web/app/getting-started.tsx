import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { DashboardSummary } from '@/lib/types';

interface Step {
  done: boolean;
  title: string;
  detail: string;
  href: string;
  action: string;
}

/**
 * First-run checklist on the overview: the steps between an empty shop and a first paid order.
 * Hidden once every step is done. A status that can't be read counts as not done.
 */
export async function GettingStarted({ summary }: { summary: DashboardSummary }) {
  const [session, admins] = await Promise.all([
    apiGet<{ state: string }>('/api/whatsapp/session'),
    apiGet<{ active: boolean }[]>('/api/admins'),
  ]);
  const steps: Step[] = [
    {
      done: session.ok && session.data.state === 'ready',
      title: 'Link your WhatsApp number',
      detail: 'Scan the pairing code so Katale AI can receive and send messages.',
      href: '/whatsapp',
      action: 'Open WhatsApp',
    },
    {
      done: admins.ok && admins.data.some((a) => a.active),
      title: 'Add an admin number',
      detail: 'Only admin numbers can create orders, payment links and reports by chat.',
      href: '/admins',
      action: 'Add admin',
    },
    {
      done: summary.counts.products > 0,
      title: 'Add a product with a photo',
      detail: 'Name, price, stock and a photo. Customers see the photo on WhatsApp.',
      href: '/products/new',
      action: 'Add product',
    },
    {
      done: summary.counts.orders > 0,
      title: 'Create your first order',
      detail: 'Send “2 baskets for Sarah” by text or voice note, or try the Agent console.',
      href: '/console',
      action: 'Open console',
    },
    {
      done: summary.counts.paidOrders > 0,
      title: 'Get paid with PayPal',
      detail: 'Approve the payment link; the order updates when PayPal confirms the payment.',
      href: '/orders',
      action: 'View orders',
    },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <section
      aria-labelledby="getting-started"
      className="mb-6 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="getting-started" className="text-sm font-semibold text-slate-700">
          Get started
        </h2>
        <p className="text-xs text-slate-500">
          {steps.length - remaining} of {steps.length} done
        </p>
      </div>
      <ol className="mt-3 divide-y divide-slate-100">
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
