'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from 'react';
import s from '../shop.module.css';

type Kind = 'results' | 'page';

interface NavigationValue {
  pending: boolean;
  /** True while new catalogue results load, so the grid can show placeholders. */
  loadingResults: boolean;
  /** Fades only follow a customer's own navigation, never the first paint. */
  navigated: boolean;
  go: (href: string, options?: { kind?: Kind; replace?: boolean; scroll?: boolean }) => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

export function useShopNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useShopNavigation needs ShopNavigation');
  return value;
}

/**
 * Page changes as React transitions, so the current page stays until the next is ready and a real
 * 404 can still be returned. (A route-level loading.tsx would start the response before the server
 * knows a shop or product exists, turning every missing page into a 200.)
 */
export function ShopNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<Kind>('page');
  const [navigated, setNavigated] = useState(false);
  const go = useCallback<NavigationValue['go']>(
    (href, options = {}) => {
      setKind(options.kind ?? 'page');
      setNavigated(true);
      start(() => {
        const navigate = options.replace ? router.replace : router.push;
        navigate(href, { scroll: options.scroll ?? true });
      });
    },
    [router],
  );
  const value = useMemo(
    () => ({ pending, loadingResults: pending && kind === 'results', navigated, go }),
    [pending, kind, navigated, go],
  );
  return (
    <NavigationContext.Provider value={value}>
      {pending && <span className={s.progress} aria-hidden="true" />}
      {children}
    </NavigationContext.Provider>
  );
}

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** A real link (new tabs and no-JavaScript still work) that shows progress while the page loads. */
export function ShopLink({
  href,
  kind,
  scroll,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href'> & { href: string; kind?: Kind }) {
  const { go } = useShopNavigation();
  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isPlainClick(event)) return;
        event.preventDefault();
        go(href, { ...(kind ? { kind } : {}), ...(scroll === false ? { scroll: false } : {}) });
      }}
    />
  );
}

export function ProductSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={s.grid} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <div className={s.skeletonPhoto} />
          <div className={s.skeletonLine} />
          <div className={s.skeletonShort} />
        </div>
      ))}
    </div>
  );
}

/** Catalogue results: placeholders while new ones load, and a short fade when they arrive. */
export function ResultsArea({ children }: { children: ReactNode }) {
  const { loadingResults, navigated } = useShopNavigation();
  return loadingResults ? (
    <div role="status" aria-label="Loading products">
      <ProductSkeleton />
    </div>
  ) : (
    <div className={navigated ? s.results : undefined}>{children}</div>
  );
}
