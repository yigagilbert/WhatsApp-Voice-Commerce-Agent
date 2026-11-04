'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_LINE_QUANTITY,
  productImage,
  shopHref,
  type CheckoutResponse,
  type QuotedLine,
} from '@/lib/storefront-types';
import { useCart } from './cart-context';
import { WhatsAppIcon } from './whatsapp-icon';
import s from '../shop.module.css';

interface Handoff {
  reference: string;
  url: string;
  expiresAt: string;
}

const POLL_MS = 4000;

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className={s.stepper} role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`${label}: one fewer`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button
        type="button"
        aria-label={`${label}: one more`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

function CartLine({ line, shop }: { line: QuotedLine; shop: string }) {
  const { setQuantity } = useCart();
  const name = line.name ?? 'This product';
  return (
    <li className={s.line}>
      <div className={s.linePhoto}>
        {line.imageVersion ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={productImage(shop, line.productId, line.imageVersion, 'thumb')}
            alt=""
            width={72}
            height={72}
            loading="lazy"
          />
        ) : (
          <span className={s.noPhoto} aria-hidden="true">
            {name.slice(0, 1)}
          </span>
        )}
      </div>
      <div className={s.lineBody}>
        <p className={s.lineName}>
          {line.name ? (
            <a href={shopHref(shop, false, `/p/${line.productId}`)}>{line.name}</a>
          ) : (
            name
          )}
        </p>
        {line.issue ? (
          <p className={s.lineIssue}>{line.message}</p>
        ) : (
          <p className={s.linePrice}>
            {line.unit} each
            {line.listUnit && (
              <>
                {' '}
                <s>{line.listUnit}</s>{' '}
                <span className={s.lineDeal}>
                  {line.discount === 'BUNDLE' ? 'Bundle price' : 'Bulk price'}
                </span>
              </>
            )}
          </p>
        )}
        <div className={s.lineControls}>
          {line.name && line.issue !== 'out_of_stock' && line.issue !== 'unavailable' ? (
            <Stepper
              label={name}
              value={line.quantity}
              min={1}
              max={Math.max(line.quantity, MAX_LINE_QUANTITY)}
              onChange={(quantity) => setQuantity(line.productId, quantity)}
            />
          ) : null}
          <button
            type="button"
            className={s.remove}
            onClick={() => setQuantity(line.productId, 0)}
            aria-label={`Remove ${name} from your cart`}
          >
            Remove
          </button>
        </div>
      </div>
      {!line.issue && <p className={s.lineTotal}>{line.lineTotal}</p>}
    </li>
  );
}

/**
 * The floating cart bubble and the cart itself. Checkout never trusts this page: the backend
 * re-prices the cart, and the customer sees any change before a reference is created. Opening
 * WhatsApp changes nothing on the server; the status here changes only when the message arrives.
 */
export function CartDrawer({
  shopName,
  checkoutAvailable,
}: {
  shopName: string;
  checkoutAvailable: boolean;
}) {
  const cart = useCart();
  const { slug, items, count, quote, loading, error, drawerOpen, openDrawer, closeDrawer } = cart;
  const dialog = useRef<HTMLDialogElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [received, setReceived] = useState(false);
  const [expired, setExpired] = useState(false);
  const sessionKey = `katale-handoff:${slug}`;

  // A customer who went to WhatsApp and came back (even after a reload) sees where things stand.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(sessionKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Handoff;
      if (new Date(saved.expiresAt) > new Date()) {
        setHandoff(saved);
        openDrawer();
      } else window.sessionStorage.removeItem(sessionKey);
    } catch {
      // Without session storage the customer simply starts from the cart.
    }
  }, [sessionKey]);

  const rememberHandoff = useCallback(
    (value: Handoff | null) => {
      setHandoff(value);
      try {
        if (value) window.sessionStorage.setItem(sessionKey, JSON.stringify(value));
        else window.sessionStorage.removeItem(sessionKey);
      } catch {
        // See above.
      }
    },
    [sessionKey],
  );

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (drawerOpen && !el.open) el.showModal();
    if (!drawerOpen && el.open) el.close();
  }, [drawerOpen]);

  const { clear } = cart;
  useEffect(() => {
    if (!handoff) return;
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/shop/${slug}/api/status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference: handoff.reference }),
        });
        if (!res.ok || stopped) return;
        const { status } = (await res.json()) as { status: 'waiting' | 'received' | 'expired' };
        if (status === 'received') {
          setReceived(true);
          clear();
          rememberHandoff(null);
        } else if (status === 'expired') {
          setExpired(true);
          rememberHandoff(null);
        }
      } catch {
        // Offline for a moment: the next check will catch up.
      }
    };
    void check();
    const timer = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [handoff, slug, clear, rememberHandoff]);

  const checkout = async () => {
    if (!quote || submitting) return;
    setSubmitting(true);
    setNotice(null);
    setExpired(false);
    // Opened during the click: browsers block new tabs opened after waiting for a response.
    const tab = window.open('', '_blank');
    try {
      const res = await fetch(`/shop/${slug}/api/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, quote: quote.quote, clientKey: cart.clientKey }),
      });
      if (res.status === 429)
        throw new Error('Too many checkout attempts. Wait a minute, then try again.');
      if (!res.ok) throw new Error('Checkout could not start. Try again in a moment.');
      const result = (await res.json()) as CheckoutResponse;
      if (result.status === 'ready') {
        rememberHandoff({
          reference: result.reference,
          url: result.whatsappUrl,
          expiresAt: result.expiresAt,
        });
        if (tab) tab.location.href = result.whatsappUrl;
        return;
      }
      tab?.close();
      if (result.status === 'unavailable')
        setNotice(`${shopName} isn't taking WhatsApp orders right now. Your cart is saved.`);
      else {
        cart.setQuote(result.cart);
        setNotice(
          result.status === 'changed'
            ? 'Prices or stock changed. Check your cart, then continue.'
            : 'Some items need your attention before you can check out.',
        );
      }
    } catch (cause) {
      tab?.close();
      setNotice((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setReceived(false);
    closeDrawer();
  };

  if (!cart.ready) return null;
  const showBar = count > 0 && !drawerOpen;

  return (
    <>
      {showBar && (
        <button type="button" className={s.bubble} onClick={openDrawer}>
          <span className={s.bubbleCount}>{count}</span>
          <span className={s.bubbleText}>
            {count === 1 ? '1 item' : `${count} items`}
            {quote?.ready ? `, ${quote.subtotal}` : ''}
          </span>
          <span className={s.bubbleAction}>View cart</span>
        </button>
      )}
      <dialog
        ref={dialog}
        className={s.drawer}
        aria-label="Your cart"
        onClose={closeDrawer}
        onClick={(event) => {
          if (event.target === dialog.current) closeDrawer();
        }}
      >
        <div className={s.drawerInner}>
          <header className={s.drawerHead}>
            <h2>{handoff || received ? 'Continue on WhatsApp' : 'Your cart'}</h2>
            <button type="button" className={s.close} onClick={closeDrawer} aria-label="Close cart">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="m3 3 10 10M13 3 3 13"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          {received ? (
            <div className={s.handoff} role="status">
              <p className={s.handoffDone}>{shopName} has your cart.</p>
              <p className={s.muted}>
                Finish your order in the WhatsApp chat: confirm your delivery details and pay
                securely with PayPal.
              </p>
              <button type="button" className={s.ghostButton} onClick={reset}>
                Keep browsing
              </button>
            </div>
          ) : handoff ? (
            <div className={s.handoff}>
              <p className={s.muted}>Send this message in WhatsApp to continue your order.</p>
              <div className={s.messagePreview}>
                <p>Hi {shopName}! I&apos;d like to check out my cart from your website.</p>
                <p className={s.reference}>Cart reference: {handoff.reference}</p>
              </div>
              <a className={s.send} href={handoff.url} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon />
                Open WhatsApp
              </a>
              <p className={s.waiting} role="status">
                <span className={s.pulse} aria-hidden="true" />
                Waiting for your message. Your cart stays here until it arrives.
              </p>
              <button type="button" className={s.textButton} onClick={() => rememberHandoff(null)}>
                Back to your cart
              </button>
            </div>
          ) : !items.length ? (
            <div className={s.handoff}>
              <p className={s.muted}>Your cart is empty. Add products to see them here.</p>
              <button type="button" className={s.ghostButton} onClick={closeDrawer}>
                Browse products
              </button>
            </div>
          ) : (
            <>
              <div className={s.lines}>
                {!quote && !error && <p className={s.muted}>Checking prices…</p>}
                {quote && (
                  <ul>
                    {quote.lines.map((line) => (
                      <CartLine key={line.productId} line={line} shop={slug} />
                    ))}
                  </ul>
                )}
              </div>
              <footer className={s.drawerFoot}>
                {(notice || error || quote?.notice || expired) && (
                  <p className={s.notice} role="alert">
                    {expired
                      ? 'That checkout expired or was replaced. Nothing was ordered. Start it again below.'
                      : (notice ?? error ?? quote?.notice)}
                  </p>
                )}
                {quote?.savings && (
                  <p className={s.totalRow}>
                    <span>You save</span>
                    <span className={s.lineDeal}>{quote.savings}</span>
                  </p>
                )}
                <p className={`${s.totalRow} ${s.subtotal}`}>
                  <span>Subtotal</span>
                  <span>{quote?.subtotal ?? ''}</span>
                </p>
                <p className={s.muted}>
                  Confirm delivery and pay securely with PayPal in the WhatsApp chat.
                </p>
                <button
                  type="button"
                  className={s.send}
                  disabled={!quote?.ready || loading || submitting || !checkoutAvailable}
                  onClick={checkout}
                >
                  <WhatsAppIcon />
                  {submitting ? 'Preparing your order…' : 'Checkout on WhatsApp'}
                </button>
                {!checkoutAvailable && (
                  <p className={s.notice}>
                    {shopName} isn&apos;t taking WhatsApp orders right now. Your cart is saved.
                  </p>
                )}
              </footer>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
