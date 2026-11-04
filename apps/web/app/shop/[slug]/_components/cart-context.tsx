'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MAX_LINE_QUANTITY, type CartQuote } from '@/lib/storefront-types';

export interface CartItem {
  productId: string;
  quantity: number;
}

interface Stored {
  items: CartItem[];
  clientKey: string;
  savedAt: number;
}

/** An abandoned cart quietly starts over after this long. */
const CART_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const QUOTE_DEBOUNCE_MS = 220;

const newClientKey = () => crypto.randomUUID().replaceAll('-', '');

// Storage can throw (private windows, blocked site data): the cart then lasts for this page view.
const load = (key: string): Stored | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    if (!Array.isArray(stored.items) || Date.now() - stored.savedAt > CART_TTL_MS) return null;
    return stored;
  } catch {
    return null;
  }
};
const save = (key: string, stored: Stored) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Nothing to do: the cart keeps working in memory.
  }
};

interface CartValue {
  slug: string;
  items: CartItem[];
  count: number;
  /** False until the browser's saved cart has been read (avoids a flash of "empty"). */
  ready: boolean;
  clientKey: string;
  quote: CartQuote | null;
  loading: boolean;
  error: string | null;
  add: (productId: string, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  clear: () => void;
  setQuote: (quote: CartQuote) => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const CartContext = createContext<CartValue | null>(null);

export function useCart() {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart needs a CartProvider');
  return value;
}

/**
 * The cart lives in this browser, holding only product IDs and quantities. Names, prices and stock
 * always come from the backend's quote, so a stale tab can't show or send an old price.
 */
export function CartProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const storageKey = `katale-cart:${slug}`;
  const [items, setItems] = useState<CartItem[]>([]);
  const [clientKey, setClientKey] = useState('');
  const [ready, setReady] = useState(false);
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const keyRef = useRef('');
  // Always the latest cart, so quick taps between renders never overwrite each other.
  const itemsRef = useRef<CartItem[]>([]);

  useEffect(() => {
    const stored = load(storageKey);
    const key = stored?.clientKey ?? newClientKey();
    keyRef.current = key;
    setClientKey(key);
    itemsRef.current = stored?.items ?? [];
    setItems(itemsRef.current);
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      itemsRef.current = load(storageKey)?.items ?? [];
      setItems(itemsRef.current);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  const commit = useCallback(
    (next: CartItem[]) => {
      itemsRef.current = next;
      setItems(next);
      save(storageKey, { items: next, clientKey: keyRef.current, savedAt: Date.now() });
    },
    [storageKey],
  );

  useEffect(() => {
    if (!ready) return;
    if (!items.length) {
      setQuote(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/shop/${slug}/api/cart`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        setQuote((await res.json()) as CartQuote);
        setError(null);
      } catch (cause) {
        if ((cause as Error).name !== 'AbortError')
          setError('Prices could not be checked. Check your connection and try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [items, ready, slug]);

  const value = useMemo<CartValue>(
    () => ({
      slug,
      items,
      count: items.reduce((sum, i) => sum + i.quantity, 0),
      ready,
      clientKey,
      quote,
      loading,
      error,
      setQuote,
      add: (productId, quantity = 1) => {
        const current = itemsRef.current;
        const line = current.find((i) => i.productId === productId);
        commit(
          line
            ? current.map((i) =>
                i.productId === productId
                  ? { ...i, quantity: Math.min(i.quantity + quantity, MAX_LINE_QUANTITY) }
                  : i,
              )
            : [...current, { productId, quantity: Math.min(quantity, MAX_LINE_QUANTITY) }],
        );
      },
      setQuantity: (productId, quantity) => {
        const current = itemsRef.current;
        commit(
          quantity <= 0
            ? current.filter((i) => i.productId !== productId)
            : current.map((i) =>
                i.productId === productId
                  ? { ...i, quantity: Math.min(quantity, MAX_LINE_QUANTITY) }
                  : i,
              ),
        );
      },
      clear: () => {
        keyRef.current = newClientKey();
        setClientKey(keyRef.current);
        commit([]);
      },
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    }),
    [slug, items, ready, clientKey, quote, loading, error, drawerOpen, commit],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
