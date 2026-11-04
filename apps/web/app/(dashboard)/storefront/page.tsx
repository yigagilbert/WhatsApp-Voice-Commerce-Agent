import Link from 'next/link';
import QRCode from 'qrcode';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { siteUrl } from '@/lib/public-site';
import type { StorefrontSettings } from '@/lib/types';
import { CopyLink, LogoForm, StorefrontForm } from './storefront-forms';

export const dynamic = 'force-dynamic';

const whatsappShare = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

export default async function StorefrontPage() {
  const result = await apiGet<StorefrontSettings>('/api/storefront');
  if (!result.ok)
    return (
      <>
        <PageHeader title="Storefront" />
        <ErrorNotice message={result.error} />
      </>
    );
  const settings = result.data;
  const origin = await siteUrl();
  const url = `${origin}/shop/${settings.slug}`;
  const qr = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1c2329', light: '#ffffff' },
  });
  const qrDownload = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
  const { products } = settings;

  return (
    <>
      <PageHeader
        title="Storefront"
        description="Your public catalogue. Customers browse here and finish every order with Katale AI on WhatsApp. Product changes show up on their own."
      />

      {settings.enabled && settings.checkoutBlocker && (
        <div className="mb-4 max-w-4xl">
          <ErrorNotice
            message={`Customers can browse, but they can't check out yet. ${settings.checkoutBlocker}`}
          />
        </div>
      )}

      <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <StorefrontForm settings={settings} origin={origin} />
          <LogoForm settings={settings} />
        </div>

        <div className="space-y-4">
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              {settings.enabled ? 'Share your shop' : 'Your shop is private'}
            </h2>
            <p className="break-all text-sm text-slate-600">{url}</p>
            <div className="flex flex-wrap gap-2">
              {settings.enabled && <CopyLink url={url} />}
              {settings.saved && (
                <a
                  href={settings.enabled ? url : `${url}?preview=1`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {settings.enabled ? 'View storefront' : 'Preview storefront'}
                </a>
              )}
              {settings.enabled && (
                <a
                  href={whatsappShare(`Browse our products and order on WhatsApp: ${url}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Share on WhatsApp
                </a>
              )}
            </div>
            {!settings.saved && (
              <p className="text-sm text-slate-500">Save the form to preview your storefront.</p>
            )}
            {settings.enabled && (
              <div className="flex items-center gap-4">
                <div
                  role="img"
                  aria-label={`QR code for ${url}`}
                  className="w-36 shrink-0"
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
                <div className="text-sm text-slate-600">
                  <p>Print this for your stall, packaging or flyers.</p>
                  <a
                    href={qrDownload}
                    download={`${settings.slug}-qr.svg`}
                    className="mt-2 inline-block font-medium underline"
                  >
                    Download QR code
                  </a>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-5 text-sm">
            <h2 className="font-semibold text-slate-900">Products on your storefront</h2>
            <p className="text-slate-600">
              {products.shown} shown, {products.hidden} hidden.{' '}
              <Link href="/products" className="font-medium underline">
                Manage products
              </Link>
            </p>
            {(products.withoutPhoto > 0 || products.withoutCategory > 0) && (
              <p className="text-slate-500">
                To help customers find them: {products.withoutPhoto} need a photo,{' '}
                {products.withoutCategory} need a category.
              </p>
            )}
          </section>

          {settings.enabled && settings.categories.length > 0 && (
            <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-5 text-sm">
              <h2 className="font-semibold text-slate-900">Share a category</h2>
              <ul className="divide-y divide-slate-100">
                {settings.categories.map((category) => {
                  const link = `${url}?category=${encodeURIComponent(category.name)}`;
                  return (
                    <li
                      key={category.name}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <a href={link} target="_blank" rel="noreferrer" className="hover:underline">
                        {category.name} ({category.count})
                      </a>
                      <a
                        href={whatsappShare(`${category.name}: ${link}`)}
                        target="_blank"
                        rel="noreferrer"
                        className="whitespace-nowrap font-medium underline"
                        aria-label={`Share ${category.name} on WhatsApp`}
                      >
                        Share
                      </a>
                    </li>
                  );
                })}
              </ul>
              <p className="text-slate-500">
                To share one product, open it on the{' '}
                <Link href="/products" className="underline">
                  Products
                </Link>{' '}
                page.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
