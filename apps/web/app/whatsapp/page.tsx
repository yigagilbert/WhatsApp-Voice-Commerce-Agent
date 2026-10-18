import QRCode from 'qrcode';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { AutoRefresh, SessionControls } from './controls';
import {
  ConnectShopNumber,
  CustomerChats,
  ShopSettingsForm,
  type CustomerChat,
  type ShopView,
} from './shop-settings';

export const dynamic = 'force-dynamic';

interface Session {
  state: 'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure';
  qr: string | null;
  qrUpdatedAt: string | null;
  stateChangedAt: string;
  account: string | null;
  lastDisconnectReason: string | null;
}

const STATES: Record<Session['state'], { label: string; tone: string; help: string }> = {
  ready: {
    label: 'Connected',
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    help: 'Katale AI is receiving and sending WhatsApp messages.',
  },
  qr: {
    label: 'Waiting for pairing',
    tone: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    help: 'Scan the code below with the bot phone to link this device.',
  },
  authenticated: {
    label: 'Connecting…',
    tone: 'bg-sky-50 text-sky-700 ring-sky-600/20',
    help: 'Paired. Loading chats — this takes a few seconds.',
  },
  starting: {
    label: 'Starting…',
    tone: 'bg-sky-50 text-sky-700 ring-sky-600/20',
    help: 'Starting the WhatsApp session.',
  },
  disconnected: {
    label: 'Disconnected',
    tone: 'bg-rose-50 text-rose-700 ring-rose-600/20',
    help: 'The session dropped. Katale reconnects automatically; use Reconnect to retry now.',
  },
  auth_failure: {
    label: 'Pairing failed',
    tone: 'bg-rose-50 text-rose-700 ring-rose-600/20',
    help: 'WhatsApp rejected the saved session. Unlink and pair again.',
  },
};

export default async function WhatsAppPage() {
  const result = await apiGet<Session>('/api/whatsapp/session');
  if (!result.ok) {
    return (
      <>
        <PageHeader title="WhatsApp" />
        <ErrorNotice message={result.error} />
        <AutoRefresh seconds={10} />
        <ShopSection />
      </>
    );
  }
  const s = result.data;
  const meta = STATES[s.state];
  // Rendered on the server from the worker's pairing code; never logged or cached.
  const qrSvg =
    s.state === 'qr' && s.qr
      ? await QRCode.toString(s.qr, { type: 'svg', margin: 1, width: 264 })
      : null;
  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="The WhatsApp number Katale AI runs on. Pair it once with a QR code; the session is kept across restarts."
      />
      <AutoRefresh seconds={s.state === 'ready' ? 30 : 4} />
      <section className="max-w-2xl rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset ${meta.tone}`}
            >
              {meta.label}
            </span>
            {s.account && <span className="text-sm text-slate-600">Linked number {s.account}</span>}
          </div>
          <SessionControls connected={s.state === 'ready' || s.state === 'authenticated'} />
        </div>
        <p className="mt-3 text-sm text-slate-600">{meta.help}</p>
        <p className="mt-1 text-xs text-slate-500">
          Since {dateTime(s.stateChangedAt)}
          {s.lastDisconnectReason && s.state !== 'ready'
            ? ` · last disconnect: ${s.lastDisconnectReason.toLowerCase()}`
            : ''}
        </p>

        {qrSvg && (
          <div className="mt-5 flex flex-col items-center gap-3 rounded-lg border border-dashed border-slate-300 p-5 sm:flex-row sm:items-start">
            <div
              className="h-[264px] w-[264px] shrink-0 bg-white"
              aria-label="WhatsApp pairing QR code"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
              <li>On the bot phone, open WhatsApp.</li>
              <li>
                Go to <strong>Settings → Linked devices → Link a device</strong>.
              </li>
              <li>Point the camera at this code. It refreshes automatically.</li>
              <li className="text-xs text-slate-500">
                Only scan with the phone that owns the bot number. Anyone who scans this code
                controls the bot.
              </li>
            </ol>
          </div>
        )}
      </section>
      <ShopSection />
    </>
  );
}

/** The shop's number, customer-shopping settings and customer chats (shown even if the bot is down). */
async function ShopSection() {
  const [shop, chats] = await Promise.all([
    apiGet<ShopView>('/api/whatsapp/account'),
    apiGet<CustomerChat[]>('/api/customer-chats'),
  ]);
  const account = shop.ok
    ? (shop.data.accounts.find((a) => a.active) ?? shop.data.accounts[0])
    : undefined;
  return (
    <>
      <section className="mt-6 max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Shop number and customers</h2>
          <p className="mt-1 text-sm text-slate-600">
            Each business has its own WhatsApp number. Customers who message it see only this
            shop&apos;s products; your admin numbers keep the admin assistant.
          </p>
        </div>
        {!shop.ok ? (
          <ErrorNotice message={shop.error} />
        ) : (
          <>
            <ConnectShopNumber view={shop.data} />
            {account && <ShopSettingsForm account={account} available={shop.data.available} />}
          </>
        )}
      </section>
      {account && (
        <section className="mt-6 max-w-2xl">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">Customer chats</h2>
          {chats.ok ? <CustomerChats chats={chats.data} /> : <ErrorNotice message={chats.error} />}
        </section>
      )}
    </>
  );
}
