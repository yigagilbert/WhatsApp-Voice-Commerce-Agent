'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/orders', label: 'Orders' },
  { href: '/payments', label: 'Payments' },
  { href: '/disputes', label: 'Disputes' },
  { href: '/customers', label: 'Customers' },
  { href: '/products', label: 'Products' },
  { href: '/bargaining', label: 'Bargaining' },
  { href: '/activity', label: 'Activity' },
  { href: '/console', label: 'Agent console' },
  { href: '/reports', label: 'Reports' },
  { href: '/status', label: 'Status ads' },
  { href: '/admins', label: 'Admins' },
  { href: '/whatsapp', label: 'WhatsApp' },
  { href: '/storefront', label: 'Storefront' },
  { href: '/settings', label: 'API keys' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${
              active
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-200 hover:text-slate-900'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
