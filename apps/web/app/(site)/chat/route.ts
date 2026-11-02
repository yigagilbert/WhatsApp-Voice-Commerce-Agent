import { NextResponse } from 'next/server';
import { publicWhatsApp, siteUrl, whatsappLink } from '@/lib/public-site';

export const dynamic = 'force-dynamic';

/**
 * The stable link behind the homepage's QR code. It opens a chat with whichever number is
 * published in the dashboard right now, so printed or shared codes keep working when the number
 * changes. With no published number it goes to the homepage's chat section, which says so.
 */
export async function GET() {
  const chat = await publicWhatsApp();
  const target = chat.available ? whatsappLink(chat.phone) : `${await siteUrl()}/#chat`;
  return NextResponse.redirect(target, {
    status: 302,
    headers: { 'Cache-Control': 'no-store' },
  });
}
