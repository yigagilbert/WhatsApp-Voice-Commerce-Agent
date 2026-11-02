import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/public-site';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [{ url: `${await siteUrl()}/`, changeFrequency: 'weekly', priority: 1 }];
}
