import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadWebConfig } from '@vca/config';
import logo from '@/components/katale-logo.png';
import { currentUser } from '@/lib/auth';
import { DASHBOARD_HOME } from '@/lib/session';
import { Header, NavLinks } from './_components/header';
import s from './site.module.css';

const sandbox = () => {
  try {
    return loadWebConfig().PAYPAL_ENV === 'sandbox';
  } catch {
    return true;
  }
};

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Image src={logo} alt="" unoptimized preload className="h-8 w-auto" />
      <span className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight">
        Katale <span className="text-[var(--leaf)]">AI</span>
      </span>
    </span>
  );
}

/** The public website: header, page, footer. Signed-in merchants get a way back to the dashboard. */
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <div className={`${s.site} min-h-screen`}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-[var(--ink)] px-3 py-2 text-[var(--paper)] focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Header>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link href="/" aria-label="Katale AI home" className={`${s.link} text-[var(--ink)]`}>
            <Wordmark />
          </Link>
          <NavLinks />
          <Link
            href={user ? DASHBOARD_HOME : '/login'}
            className={`${s.btn} ${s.btnGhost} min-h-10 px-4 text-sm`}
          >
            {user ? 'Open dashboard' : 'Merchant login'}
          </Link>
        </div>
      </Header>
      <main id="main">{children}</main>
      <footer className={`${s.rule} mt-0`}>
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1.4fr_1fr]">
          <div>
            <Wordmark />
            <p className={`${s.lede} mt-3 max-w-sm text-sm`}>
              Built in Uganda for small sellers across East Africa. Works with any WhatsApp number;
              payments need a PayPal business account that can receive money in your country.
            </p>
            {sandbox() && (
              <p className={`${s.muted} mt-3 text-xs`}>
                The demo shop takes payments with PayPal Sandbox: no real money moves.
              </p>
            )}
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Link href="/#how" className={s.link}>
              How it works
            </Link>
            <Link href="/chat" className={s.link}>
              Chat on WhatsApp
            </Link>
            <Link href="/#features" className={s.link}>
              Features
            </Link>
            <Link href={user ? DASHBOARD_HOME : '/login'} className={s.link}>
              {user ? 'Open dashboard' : 'Merchant login'}
            </Link>
            <Link href="/#demo" className={s.link}>
              Demo
            </Link>
            <a
              href="https://github.com/yigagilbert/WhatsApp-Voice-Commerce-Agent"
              className={s.link}
              rel="noreferrer"
            >
              Source code
            </a>
          </nav>
        </div>
        <p className={`${s.muted} mx-auto max-w-6xl px-5 pb-10 text-xs sm:px-8`}>
          © {new Date().getFullYear()} Katale AI. PayPal is a trademark of PayPal, Inc.; WhatsApp is
          a trademark of WhatsApp LLC. Katale AI is not affiliated with either.
        </p>
      </footer>
    </div>
  );
}
