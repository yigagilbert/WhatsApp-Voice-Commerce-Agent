import Link from 'next/link';
import { apiGet } from '@/lib/api';

interface Health {
  state: string;
  downSince: string | null;
}

/** Shown on every page while the WhatsApp bot has been disconnected for over 2 minutes. */
export async function WhatsAppBanner() {
  const result = await apiGet<Health>('/api/whatsapp/health');
  if (!result.ok || !result.data.downSince) return null;
  const minutes = Math.floor((Date.now() - new Date(result.data.downSince).getTime()) / 60_000);
  if (minutes < 2) return null;
  const pairing = result.data.state === 'qr';
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      <strong>WhatsApp is {pairing ? 'waiting to be paired' : 'disconnected'}</strong> (for{' '}
      {minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} min`}). Admins can't reach
      Katale AI and reports or alerts are queued.{' '}
      <Link href="/whatsapp" className="font-medium underline">
        {pairing ? 'Scan the QR code' : 'Check the connection'}
      </Link>
    </div>
  );
}
