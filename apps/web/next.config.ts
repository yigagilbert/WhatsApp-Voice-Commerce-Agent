import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isDev = process.env.NODE_ENV === 'development';

/**
 * Content Security Policy without nonces (every page is dynamic and React escapes output; inline
 * scripts/styles are still needed by Next.js and AG Grid). The parts that matter most here:
 * no framing (clickjacking), no plugins, forms and connections only to this site.
 * 'unsafe-eval' only in development (React's dev tooling); HTTPS upgrade only in production.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Older browsers: same clickjacking protection as frame-ancestors.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@vca/commerce', '@vca/config', '@vca/shared'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  // Self-contained server for the production Docker image (.next/standalone).
  output: 'standalone',
  // Product photos (≤ 8 MB before resizing) are uploaded through a server action.
  experimental: { serverActions: { bodySizeLimit: '10mb' } },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default nextConfig;
