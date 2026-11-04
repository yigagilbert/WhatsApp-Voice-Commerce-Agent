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
import { NoPhoto } from './product-card';
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
          <NoPhoto />
        )}
      </div>
      <div className={s.lineBody}>
        <div className={s.lineTop}>
          <p className={s.lineName}>
            {line.name ? (
              <a href={shopHref(shop, false, `/p/${line.productId}`)}>{line.name}</a>
            ) : (
              name
            )}
          </p>
          {!line.issue && <p className={s.lineTotal}>{line.lineTotal}</p>}
        </div>
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
    </li>
  );
}

/**
 * The cart, its phone bar and the "added" message. Checkout never trusts this page: the backend
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

  const toast = cart.added;
  const { dismissAdded } = cart;
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissAdded, 3200);
    return () => clearTimeout(timer);
  }, [toast, dismissAdded]);

  if (!cart.ready) return null;

  return (
    <>
      <div className={s.toastRegion} role="status" aria-live="polite">
        {toast && !drawerOpen && (
          <div key={toast.at} className={s.toast}>
            <p>
              Added to cart: <strong>{toast.name}</strong>
              {toast.quantity > 1 ? ` × ${toast.quantity}` : ''}
            </p>
            <button type="button" onClick={openDrawer}>
              View cart
            </button>
          </div>
        )}
      </div>
      {count > 0 && !drawerOpen && (
        <div className={s.cartBar}>
          <p>
            <span>{count === 1 ? '1 item' : `${count} items`}</span>
            <strong>{quote?.ready ? quote.subtotal : ''}</strong>
          </p>
          <button type="button" className={s.primarySmall} onClick={openDrawer}>
            View cart
          </button>
        </div>
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
            <h2>
              {handoff || received
                ? 'Continue on WhatsApp'
                : count
                  ? `Your cart (${count})`
                  : 'Your cart'}
            </h2>
            <button
              type="button"
              className={s.iconButton}
              onClick={closeDrawer}
              aria-label="Close cart"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="m3 3 10 10M13 3 3 13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          {received ? (
            <div className={s.panel} role="status">
              <p className={s.panelLead}>{shopName} has your cart</p>
              <p className={s.muted}>
                Finish your order in the WhatsApp chat. Katale AI will confirm your delivery details
                and send a secure PayPal link.
              </p>
              <button type="button" className={s.secondary} onClick={reset}>
                Keep browsing
              </button>
            </div>
          ) : handoff ? (
            <div className={s.panel}>
              <ol className={s.handoffSteps}>
                <li>
                  <strong>Send this message in WhatsApp</strong>
                  <div className={s.messagePreview}>
                    <p>Hi {shopName}! I&apos;d like to check out my cart from your website.</p>
                    <p className={s.reference}>
                      Cart reference:<span>{handoff.reference}</span>
                    </p>
                  </div>
                </li>
                <li>
                  <strong>Confirm your order</strong>
                  <span>
                    Katale AI, the assistant for {shopName}, checks your delivery details.
                  </span>
                </li>
                <li>
                  <strong>Pay securely</strong>
                  <span>You&apos;ll get a PayPal link in the chat.</span>
                </li>
              </ol>
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
            <div className={s.panel}>
              <p className={s.panelLead}>Your cart is empty</p>
              <p className={s.muted}>Products you add will appear here.</p>
              <button type="button" className={s.secondary} onClick={closeDrawer}>
                Browse products
              </button>
            </div>
          ) : (
            <>
              <div className={s.lines}>
                {!quote && !error && (
                  <div role="status" aria-label="Checking prices">
                    {items.map((item) => (
                      <div key={item.productId} className={s.lineSkeleton}>
                        <div className={s.skeletonPhoto} />
                        <div>
                          <div className={s.skeletonLine} />
                          <div className={s.skeletonShort} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
                <section aria-labelledby="order-summary" className={s.summary}>
                  <h3 id="order-summary">Order summary</h3>
                  {quote?.savings && (
                    <p className={s.totalRow}>
                      <span>You save</span>
                      <span className={s.lineDeal}>{quote.savings}</span>
                    </p>
                  )}
                  <p className={s.totalRow}>
                    <span>Delivery</span>
                    <span className={s.mutedInline}>Confirmed on WhatsApp</span>
                  </p>
                  <p className={`${s.totalRow} ${s.subtotal}`} data-loading={loading || undefined}>
                    <span>Subtotal</span>
                    <span>{quote?.subtotal ?? ''}</span>
                  </p>
                </section>
                <button
                  type="button"
                  className={s.send}
                  disabled={!quote?.ready || loading || submitting || !checkoutAvailable}
                  onClick={checkout}
                >
                  <WhatsAppIcon />
                  {submitting ? 'Preparing your order…' : 'Checkout on WhatsApp'}
                </button>
                {checkoutAvailable ? (
                  <p className={s.sendNote}>
                    You&apos;ll continue in WhatsApp, where Katale AI, the assistant for {shopName},
                    confirms delivery and sends a secure PayPal link.
                  </p>
                ) : (
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
