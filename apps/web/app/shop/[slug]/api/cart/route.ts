import { relayJson } from '@/lib/storefront';

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return relayJson(`/api/public/shop/${encodeURIComponent(slug)}/cart`, {
    method: 'POST',
    body: await request.text(),
    headers: { 'content-type': 'application/json' },
  });
}
