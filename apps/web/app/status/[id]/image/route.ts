import { loadWebConfig } from '@vca/config';
import { requireUser } from '@/lib/auth';
import { BOOTSTRAP_USER_ID } from '@/lib/session';

/**
 * A Status advert image (1080 × 1920 JPEG), fetched with the server-side API token and the
 * signed-in account's session. `?download=1` makes the browser save it, ready to post on WhatsApp.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const cfg = loadWebConfig();
  const res = await fetch(
    `${cfg.API_BASE_URL.replace(/\/$/, '')}/api/status-ads/${encodeURIComponent(id)}/image`,
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
  const download = new URL(request.url).searchParams.get('download') === '1';
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-cache',
      ...(download
        ? { 'content-disposition': `attachment; filename="status-${id.slice(-8)}.jpg"` }
        : {}),
    },
  });
}
