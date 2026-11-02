'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import s from '../site.module.css';

/** Sticky header that gains a hairline once the page scrolls. */
export function Header({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header className={s.header} data-scrolled={scrolled}>
      {children}
    </header>
  );
}

export const NAV = [
  { href: '#how', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#demo', label: 'Demo' },
  { href: '#chat', label: 'Try it' },
];

export function NavLinks() {
  return (
    <nav aria-label="Homepage sections" className="hidden items-center gap-6 text-sm md:flex">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className={s.link}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
