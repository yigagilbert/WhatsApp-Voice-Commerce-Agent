'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/orders', label: 'Orders' },
  { href: '/payments', label: 'Payments' },
  { href: '/disputes', label: 'Disputes' },
  { href: '/customers', label: 'Customers' },
  { href: '/products', label: 'Products' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/activity', label: 'Activity' },
  { href: '/console', label: 'Agent console' },
  { href: '/reports', label: 'Reports' },
  { href: '/admins', label: 'Admins' },
  { href: '/whatsapp', label: 'WhatsApp' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
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
