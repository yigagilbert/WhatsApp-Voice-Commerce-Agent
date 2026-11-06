/**
 * Only the homepage and storefronts are for search engines; the dashboard is private. Crawlers also
 * need the CSS, JavaScript and images those pages are built from, or they can't render them.
 */
export const ROBOTS_RULES = {
  userAgent: '*',
  allow: ['/$', '/shop/', '/_next/static/', '/_next/image'],
  disallow: '/',
};
