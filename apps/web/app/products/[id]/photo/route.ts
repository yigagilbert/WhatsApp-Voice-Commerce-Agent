import { loadWebConfig } from '@vca/config';
import { requireUser } from '@/lib/auth';

/** The product photo for the dashboard (proxied with the server-side API token). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const cfg = loadWebConfig();
  const res = await fetch(
    `${cfg.API_BASE_URL.replace(/\/$/, '')}/api/products/${encodeURIComponent(id)}/image`,
    { headers: { authorization: `Bearer ${cfg.API_AUTH_TOKEN}` }, cache: 'no-store' },
  );
  if (!res.ok) return new Response(null, { status: 404 });
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': 'private, no-store',
    },
  });
}
