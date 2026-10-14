import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { loadWebConfig } from '@vca/config';
import { currentUser } from '@/lib/auth';
import { logout } from './login/actions';
import './globals.css';

export const metadata: Metadata = {
  title: 'Katale AI — Merchant Dashboard',
  description: 'Conversational commerce for businesses that sell through chat and voice.',
};

const paypalEnvironment = () => {
  try {
    return loadWebConfig().PAYPAL_ENV;
  } catch {
    return 'sandbox';
  }
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="antialiased">
        {user ? (
          <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col md:flex-row">
            <aside className="border-b border-slate-200 p-4 md:w-56 md:shrink-0 md:border-r md:border-b-0">
              <div className="mb-4 px-3">
                <p className="text-sm font-semibold text-slate-900">Katale AI</p>
                <p className="text-xs text-slate-500">Conversational commerce</p>
                {paypalEnvironment() === 'sandbox' && (
                  <p
                    className="mt-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20"
                    title="Payments use PayPal Sandbox: no real money moves."
                  >
                    PayPal Sandbox · test payments
                  </p>
                )}
              </div>
              <Nav />
              <form action={logout} className="mt-4 px-3">
                <p className="text-xs text-slate-500">Signed in as {user}</p>
                <button className="mt-1 text-xs font-medium text-slate-700 hover:underline">
                  Sign out
                </button>
              </form>
            </aside>
            <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
          </div>
        ) : (
          <main className="p-4">{children}</main>
        )}
      </body>
    </html>
  );
}
