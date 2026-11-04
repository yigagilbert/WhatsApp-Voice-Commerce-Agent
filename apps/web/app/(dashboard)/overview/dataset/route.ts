import { gzipSync } from 'node:zlib';
import { apiGet } from '@/lib/api';
import type { AnalyticsDataset } from '@/lib/types';

/**
 * The AG Studio tables, fetched by the browser after the page has painted, so the headline figures
 * are never held up by the larger payload. `apiGet` requires a signed-in user and the API scopes
 * the data to that user's merchant. Compressed here because it runs to megabytes for a busy shop
 * and repeats the same field names on every row, and merchants are often on mobile data.
 */
export async function GET(request: Request) {
  const result = await apiGet<AnalyticsDataset>('/api/dashboard/dataset');
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });

  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const body = JSON.stringify(result.data);
  if (!request.headers.get('accept-encoding')?.includes('gzip'))
    return new Response(body, { headers });
  return new Response(gzipSync(body), {
    headers: { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' },
  });
}
