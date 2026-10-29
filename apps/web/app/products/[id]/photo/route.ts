import { loadWebConfig } from '@vca/config';
import { requireUser } from '@/lib/auth';
import { BOOTSTRAP_USER_ID } from '@/lib/session';

/**
 * A product photo for the dashboard (?size=thumb|main), fetched with the server-side API token
 * and the signed-in account's session (the API checks both). The URL carries a version, so the
 * browser may cache it privately; a new photo gets a new URL.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const size = new URL(request.url).searchParams.get('size') === 'thumb' ? 'thumb' : 'main';
  const cfg = loadWebConfig();
  const res = await fetch(
    `${cfg.API_BASE_URL.replace(/\/$/, '')}/api/products/${encodeURIComponent(id)}/image?size=${size}`,
    {
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${cfg.API_AUTH_TOKEN}`,
        ...(user.id === BOOTSTRAP_USER_ID
          ? {}
          : { 'x-dashboard-user': user.id, 'x-dashboard-session': String(user.version) }),
      },
    },
  );
  if (!res.ok) return new Response(null, { status: res.status === 401 ? 401 : 404 });
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': 'private, max-age=86400',
    },
  });
}
