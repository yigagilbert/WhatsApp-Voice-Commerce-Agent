'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { logoutWhatsApp, reconnectWhatsApp } from './actions';

/** Re-reads the connection while pairing/connecting (QR codes rotate about every 20 s). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function SessionControls({ connected }: { connected: boolean }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => reconnectWhatsApp())}
        className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? 'Working…' : 'Reconnect'}
      </button>
      {connected && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (
              window.confirm(
                'Unlink Katale AI from this WhatsApp account? The bot stops receiving messages until you scan a new QR code.',
              )
            )
              start(() => logoutWhatsApp());
          }}
          className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        >
          Unlink device
        </button>
      )}
    </div>
  );
}
