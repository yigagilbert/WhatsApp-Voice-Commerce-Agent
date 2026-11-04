import { relayImage } from '@/lib/storefront';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const url = new URL(request.url).searchParams;
  const query = new URLSearchParams({ size: url.get('size') ?? 'main', v: url.get('v') ?? '' });
  return relayImage(
    `/api/public/shop/${encodeURIComponent(slug)}/products/${encodeURIComponent(id)}/image?${query}`,
    request,
  );
}
