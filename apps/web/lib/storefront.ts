import 'server-only';
import { headers } from 'next/headers';
import { loadWebConfig } from '@vca/config';
import { currentUser } from './auth';
import { BOOTSTRAP_USER_ID } from './session';
import type { ProductPage, PublicProductDetail, PublicShop } from './storefront-types';

const apiBase = () => loadWebConfig().API_BASE_URL.replace(/\/$/, '');

/**
 * Asks the API for storefront data. The visitor's address is passed on so rate limits apply per
 * visitor rather than to this server. `preview` adds the signed-in owner's session; the API checks
 * it against the shop, so nobody can see another merchant's unpublished storefront.
 */
export async function storefrontFetch(
  path: string,
  init: RequestInit & { preview?: boolean } = {},
) {
  const { preview, ...rest } = init;
  const incoming = await headers();
  const forwarded = incoming.get('x-forwarded-for');
  const extra: Record<string, string> = forwarded ? { 'x-forwarded-for': forwarded } : {};
  if (preview) {
    const user = await currentUser();
    if (user) {
      extra.authorization = `Bearer ${loadWebConfig().API_AUTH_TOKEN}`;
      extra['x-storefront-preview'] = '1';
      if (user.id !== BOOTSTRAP_USER_ID) {
        extra['x-dashboard-user'] = user.id;
        extra['x-dashboard-session'] = String(user.version);
      }
    }
  }
  return fetch(`${apiBase()}${path}`, {
    ...rest,
    cache: 'no-store',
    headers: { ...extra, ...rest.headers },
    signal: AbortSignal.timeout(15_000),
  });
}

const read = async <T>(path: string, preview: boolean): Promise<T | null> => {
  const res = await storefrontFetch(path, { preview });
  if (res.status === 404 || res.status === 401) return null;
  if (!res.ok) throw new Error(`Storefront API responded ${res.status}`);
  return (await res.json()) as T;
};

const shopPath = (slug: string) => `/api/public/shop/${encodeURIComponent(slug)}`;

export const fetchShop = (slug: string, preview = false) =>
  read<PublicShop>(shopPath(slug), preview);

export const fetchProducts = (slug: string, query: URLSearchParams, preview = false) =>
  read<ProductPage>(`${shopPath(slug)}/products?${query}`, preview);

export const fetchProduct = (slug: string, id: string, preview = false) =>
  read<PublicProductDetail>(`${shopPath(slug)}/products/${encodeURIComponent(id)}`, preview);

export async function fetchPublishedShops(): Promise<{ slug: string; updatedAt: string }[]> {
  const res = await fetch(`${apiBase()}/api/public/shops`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return [];
  return ((await res.json()) as { shops: { slug: string; updatedAt: string }[] }).shops;
}

export async function fetchProductIds(slug: string) {
  const res = await fetch(`${apiBase()}${shopPath(slug)}/product-ids`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return [];
  return ((await res.json()) as { products: { id: string; updatedAt: string }[] }).products;
}

/** Passes a browser's storefront request to the API; the browser only ever talks to this site. */
export async function relayJson(path: string, init: RequestInit = {}) {
  try {
    const res = await storefrontFetch(path, init);
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: { message: 'The shop is not responding. Try again in a moment.' } },
      { status: 503 },
    );
  }
}

/** Passes an image through with the API's caching headers. */
export async function relayImage(path: string, request: Request) {
  const preview = new URL(request.url).searchParams.get('preview') === '1';
  const ifNoneMatch = request.headers.get('if-none-match');
  const res = await storefrontFetch(path, {
    preview,
    ...(ifNoneMatch ? { headers: { 'if-none-match': ifNoneMatch } } : {}),
  });
  if (res.status === 304) return new Response(null, { status: 304 });
  if (!res.ok) return new Response(null, { status: res.status === 429 ? 429 : 404 });
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': preview
        ? 'private, no-store'
        : (res.headers.get('cache-control') ?? 'public, max-age=300'),
      ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}),
    },
  });
}
