import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/public-site';

/** Only the homepage and storefronts are for search engines; the dashboard is private. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteUrl();
  return {
    rules: { userAgent: '*', allow: ['/$', '/shop/'], disallow: '/' },
    sitemap: `${origin}/sitemap.xml`,
  };
}
