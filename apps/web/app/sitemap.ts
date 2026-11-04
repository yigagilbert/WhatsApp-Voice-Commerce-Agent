import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/public-site';
import { fetchProductIds, fetchPublishedShops } from '@/lib/storefront';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteUrl();
  const shops = await fetchPublishedShops().catch(() => []);
  const entries = await Promise.all(
    shops.map(async (shop) => [
      {
        url: `${origin}/shop/${shop.slug}`,
        lastModified: shop.updatedAt,
        changeFrequency: 'daily' as const,
        priority: 0.8,
      },
      ...(await fetchProductIds(shop.slug).catch(() => [])).map((product) => ({
        url: `${origin}/shop/${shop.slug}/p/${product.id}`,
        lastModified: product.updatedAt,
      })),
    ]),
  );
  return [{ url: `${origin}/`, changeFrequency: 'weekly', priority: 1 }, ...entries.flat()];
}
