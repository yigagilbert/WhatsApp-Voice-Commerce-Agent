/** The public storefront API's shapes, shared by server pages and browser components. */

export type Availability = 'In stock' | 'Low stock' | 'Out of stock';

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  priceMinor: number;
  price: string;
  currency: string;
  availability: Availability;
  imageVersion: string | null;
  negotiable: boolean;
  deals: { minQuantity: number; percentOff: number }[];
}

export interface PublicProductDetail extends PublicProduct {
  related: PublicProduct[];
}

export interface PublicShop {
  slug: string;
  name: string;
  tagline: string | null;
  about: string | null;
  shopInfo: string | null;
  logoVersion: string | null;
  currency: string;
  checkoutAvailable: boolean;
  whatsappNumber: string | null;
  preview: boolean;
  totalProducts: number;
  categories: { name: string; count: number }[];
}

export interface ProductPage {
  products: PublicProduct[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

export interface QuotedLine {
  productId: string;
  name: string | null;
  imageVersion: string | null;
  quantity: number;
  unitMinor: number;
  unit: string;
  listUnit: string | null;
  discount: 'QUANTITY' | 'BUNDLE' | null;
  lineTotal: string;
  availability: Availability | null;
  issue: 'unavailable' | 'out_of_stock' | 'insufficient' | 'limit' | 'currency' | null;
  message: string | null;
}

export interface CartQuote {
  lines: QuotedLine[];
  subtotal: string;
  savings: string | null;
  currency: string;
  quote: string;
  ready: boolean;
  notice: string | null;
}

export type CheckoutResponse =
  | { status: 'unavailable' }
  | { status: 'invalid' | 'changed'; cart: CartQuote }
  | {
      status: 'ready';
      reference: string;
      whatsappUrl: string;
      expiresAt: string;
      cart: CartQuote;
    };

export const MAX_LINE_QUANTITY = 20;

/** What the customer has chosen on the catalogue; all of it lives in the URL. */
export interface CatalogueState {
  q: string;
  category: string;
  sort: string;
  inStock: boolean;
  preview: boolean;
}

export const catalogueUrl = (slug: string, c: Partial<CatalogueState>) => {
  const params = new URLSearchParams();
  if (c.q) params.set('q', c.q);
  if (c.category) params.set('category', c.category);
  if (c.sort && c.sort !== 'name') params.set('sort', c.sort);
  if (c.inStock) params.set('inStock', '1');
  if (c.preview) params.set('preview', '1');
  const query = params.toString();
  return `/shop/${slug}${query ? `?${query}` : ''}`;
};

/** Where a shop's images and links live. `preview` keeps an owner inside their private preview. */
export const shopHref = (slug: string, preview = false, path = '') =>
  `/shop/${slug}${path}${preview ? '?preview=1' : ''}`;

export const productImage = (
  slug: string,
  productId: string,
  version: string,
  size: 'thumb' | 'card' | 'main',
  preview = false,
) =>
  `/shop/${slug}/api/img/${encodeURIComponent(productId)}?size=${size}&v=${encodeURIComponent(version)}${preview ? '&preview=1' : ''}`;
