import { relayJson } from '@/lib/storefront';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const query = new URL(request.url).search;
  return relayJson(`/api/public/shop/${encodeURIComponent(slug)}/products${query}`);
}
