import { beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { toMajorString } from '@vca/commerce/money';
import { draftFromForm, parseDraft } from './form-draft';
import { cellChange } from './product-cell';
import { ROBOTS_RULES } from './robots-rules';
import {
  SESSION_ENDED_MESSAGE,
  isRedirectError,
  isSessionEndedError,
  loginAfterSessionEnded,
  pagePath,
} from './session-ended';
import { buildSetup, payPalCurrencyProblem, type SetupFacts } from './setup-checklist';
import { afterAutoOpen, afterClose, isHandoffExpired, parseHandoff } from './storefront-handoff';

beforeAll(() => {
  process.env.API_AUTH_TOKEN = 'test-dashboard-token-123456';
});

describe('session ending', () => {
  const redirectError = (url: string) =>
    Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });

  it('drops the router parameter from the page to come back to', () => {
    expect(pagePath('/orders', '?view=to-ship&_rsc=abc')).toBe('/orders?view=to-ship');
    expect(pagePath('/console', '')).toBe('/console');
  });

  it('recognises the ways an action fails once the session is gone', () => {
    expect(isSessionEndedError(new Error(SESSION_ENDED_MESSAGE))).toBe(true);
    expect(isSessionEndedError(redirectError(loginAfterSessionEnded('/products')))).toBe(true);
    expect(isSessionEndedError(redirectError('/session-ended?next=%2Fproducts'))).toBe(true);
  });

  it("doesn't mistake other failures or ordinary redirects for it", () => {
    expect(isSessionEndedError(new Error('Failed to fetch'))).toBe(false);
    expect(isSessionEndedError(redirectError('/products/abc?saved=created'))).toBe(false);
    expect(isRedirectError(redirectError('/products/abc'))).toBe(true);
    expect(isRedirectError(new Error('Failed to fetch'))).toBe(false);
  });

  it('proxy refuses a signed-out Server Action, and sends the browser to sign in', async () => {
    const { proxy } = await import('../proxy');
    const response = proxy(
      new NextRequest('http://localhost/console?x=1', {
        method: 'POST',
        headers: { 'next-action': 'abc123' },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('x-action-redirect')).toBe(
      '/login?expired=1&next=%2Fconsole%3Fx%3D1;replace',
    );
    expect(await response.text()).toBe(SESSION_ENDED_MESSAGE);
  });

  it('never comes back to the sign-out route after signing in', async () => {
    const { safeNextPath } = await import('./session');
    expect(safeNextPath('/session-ended?next=%2Forders')).toBe('/overview');
    expect(safeNextPath('/orders?view=to-ship')).toBe('/orders?view=to-ship');
  });

  it('proxy only explains itself to someone who was signed in', async () => {
    const { proxy } = await import('../proxy');
    const firstVisit = proxy(new NextRequest('http://localhost/orders'));
    expect(firstVisit.headers.get('location')).toBe('http://localhost/login?next=%2Forders');
    const staleCookie = proxy(
      new NextRequest('http://localhost/orders', {
        headers: { cookie: 'katale_session=not-valid' },
      }),
    );
    expect(staleCookie.headers.get('location')).toBe(
      'http://localhost/login?expired=1&next=%2Forders',
    );
  });
});

describe('form drafts', () => {
  it('keeps text and repeated fields, but never files', () => {
    const form = new FormData();
    form.append('name', 'Basket');
    form.append('weekdays', '1');
    form.append('weekdays', '3');
    form.append('photo', new File(['x'], 'a.png'));
    form.append('$ACTION_ID_abc', '');
    expect(draftFromForm(form, 5).values).toEqual({ name: ['Basket'], weekdays: ['1', '3'] });
  });

  it('ignores unreadable or old drafts', () => {
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft(null)).toBeNull();
    const draft = JSON.stringify({ savedAt: 0, values: { name: ['Basket'] } });
    expect(parseDraft(draft, 1000)?.values.name).toEqual(['Basket']);
    expect(parseDraft(draft, 2 * 60 * 60 * 1000)).toBeNull();
  });
});

describe('products grid cells', () => {
  it('rejects a cleared stock cell instead of saving 0', () => {
    expect(cellChange('stockQuantity', null)).toHaveProperty('problem');
    expect(cellChange('stockQuantity', '')).toHaveProperty('problem');
    expect(cellChange('stockQuantity', 2.5)).toHaveProperty('problem');
    expect(cellChange('stockQuantity', -1)).toHaveProperty('problem');
  });

  it('still lets a real zero through', () => {
    expect(cellChange('stockQuantity', 0)).toEqual({ stock: 0 });
    expect(cellChange('stockQuantity', 12)).toEqual({ stock: 12 });
  });

  it('rejects a cleared price and formats a real one', () => {
    expect(cellChange('price', null)).toHaveProperty('problem');
    expect(cellChange('price', 0)).toHaveProperty('problem');
    expect(cellChange('price', 12.5)).toEqual({ price: '12.50' });
  });

  it('passes other fields through', () => {
    expect(cellChange('category', null)).toEqual({ category: '' });
    expect(cellChange('shownLabel', 'Hidden')).toEqual({ shown: false });
  });
});

describe('setup checklist', () => {
  const ready: SetupFacts = {
    whatsappLinked: true,
    hasActiveAdmin: true,
    hasProductWithPhoto: true,
    customerShoppingAvailable: true,
    customerShoppingOn: true,
    fulfilmentOn: true,
    storefrontPublished: true,
    checkoutBlocker: null,
    paypalConfigured: true,
    currency: 'USD',
    orders: 0,
    paidOrders: 0,
  };

  it('is ready before the first order, with those steps still open', () => {
    const setup = buildSetup(ready);
    expect(setup.ready).toBe(true);
    expect(setup.remaining).toBe(2);
  });

  it('is finished once an order has been paid', () => {
    expect(buildSetup({ ...ready, orders: 1, paidOrders: 1 }).remaining).toBe(0);
  });

  it.each([
    ['storefrontPublished', false],
    ['customerShoppingOn', false],
    ['customerShoppingAvailable', false],
    ['fulfilmentOn', false],
    ['whatsappLinked', false],
    ['checkoutBlocker', 'Connect your WhatsApp number on the WhatsApp page.'],
  ])('is not ready when %s is %s', (fact, value) => {
    expect(buildSetup({ ...ready, [fact]: value }).ready).toBe(false);
  });

  it("is not ready when customers can't pay, even with every step ticked", () => {
    const ugx = buildSetup({ ...ready, currency: 'UGX', orders: 1, paidOrders: 1 });
    expect(ugx.remaining).toBe(0);
    expect(ugx.ready).toBe(false);
    expect(ugx.blockers[0]).toContain("PayPal doesn't accept UGX");
    expect(buildSetup({ ...ready, paypalConfigured: false }).ready).toBe(false);
  });

  it("doesn't block on a PayPal status it couldn't read", () => {
    expect(buildSetup({ ...ready, paypalConfigured: null }).ready).toBe(true);
  });

  it('words the currency warning as agreed', () => {
    expect(payPalCurrencyProblem('ugx')).toBe(
      "PayPal doesn't accept UGX, so customers can't pay online. Price in USD or another PayPal currency.",
    );
    expect(payPalCurrencyProblem('USD')).toBeNull();
    expect(payPalCurrencyProblem(null)).toBeNull();
  });
});

describe('storefront hand-off', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const saved = {
    reference: 'ABC',
    url: 'https://wa.me/1',
    expiresAt: '2026-11-06T13:00:00Z',
    autoOpen: true,
  };

  it('opens by itself once only', () => {
    const shown = afterAutoOpen(saved);
    expect(shown.autoOpen).toBe(false);
    expect(parseHandoff(JSON.stringify(shown), now)?.autoOpen).toBe(false);
  });

  it('stays closed once the customer has closed it', () => {
    expect(parseHandoff(JSON.stringify(afterClose(saved)), now)?.autoOpen).toBe(false);
  });

  it('still asks about a recently expired hand-off, without showing it', () => {
    const later = now + 2 * 60 * 60 * 1000;
    const late = parseHandoff(JSON.stringify(saved), later);
    expect(late?.reference).toBe('ABC');
    expect(late?.autoOpen).toBe(false);
    expect(isHandoffExpired(saved, later)).toBe(true);
  });

  it('forgets old or unreadable entries', () => {
    expect(parseHandoff(JSON.stringify(saved), now + 48 * 60 * 60 * 1000)).toBeNull();
    expect(parseHandoff('{', now)).toBeNull();
    expect(parseHandoff(JSON.stringify({ reference: 'A' }), now)).toBeNull();
  });
});

describe('search engines', () => {
  it('can fetch the assets public pages need, and not the dashboard', () => {
    expect(ROBOTS_RULES.allow).toContain('/_next/static/');
    expect(ROBOTS_RULES.disallow).toBe('/');
  });

  it('publishes zero-decimal prices without dividing by 100', () => {
    expect(toMajorString(50_000, 'UGX')).toBe('50000');
    expect(toMajorString(1250, 'USD')).toBe('12.50');
  });
});
