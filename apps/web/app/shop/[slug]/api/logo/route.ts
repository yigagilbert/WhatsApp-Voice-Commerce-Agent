import { relayImage } from '@/lib/storefront';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const v = new URL(request.url).searchParams.get('v') ?? '';
  return relayImage(
    `/api/public/shop/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(v)}`,
    request,
  );
}
