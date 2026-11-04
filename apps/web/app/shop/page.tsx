import { notFound, redirect } from 'next/navigation';
import { fetchPublishedShops } from '@/lib/storefront';

export const dynamic = 'force-dynamic';

/** With one published shop (today's deployment), /shop is that shop. */
export default async function ShopIndex() {
  const shops = await fetchPublishedShops();
  if (shops.length === 1) redirect(`/shop/${shops[0]!.slug}`);
  notFound();
}
