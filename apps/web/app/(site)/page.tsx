import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { displayPhone, publicWhatsApp, siteUrl } from '@/lib/public-site';
import { DASHBOARD_HOME } from '@/lib/session';
import { Conversation } from './_components/conversation';
import { DashboardPreview } from './_components/dashboard-preview';
import { Demo } from './_components/demo';
import { QrCode } from './_components/qr-code';
import { heroScript } from './_components/scripts';
import s from './site.module.css';

// The WhatsApp number and the signed-in state are read per request.
export const dynamic = 'force-dynamic';

function WhatsAppIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z" />
    </svg>
  );
}

const STEPS = [
  {
    title: 'Message Katale AI on WhatsApp',
    body: 'Your number is added as an admin of your shop. There is no app to install and no new screen to learn.',
    example: 'Hi Katale, what sold today?',
  },
  {
    title: 'Run the shop in plain English',
    body: 'Add products, count stock, create orders and ask questions, typed or as a voice note.',
    example: 'I have 40 wallets',
  },
  {
    title: 'Customers shop and pay with PayPal',
    body: 'They message the same number, browse with photos, fill a cart and pay through a PayPal link.',
    example: 'add 2',
  },
  {
    title: 'The numbers come to you',
    body: 'Payment notices, low-stock alerts and a scheduled sales report with a chart arrive in the chat.',
    example: '⚠️ Low stock: Barkcloth Wallet — 6 left',
  },
];

const FEATURE_GROUPS = [
  {
    title: 'In your WhatsApp',
    items: [
      [
        'A business assistant that uses your records',
        'Ask about sales, customers, stock or a single order. Answers come from your data, not from memory.',
      ],
      [
        'Products and inventory',
        'Add products and prices, record deliveries and counts, and get reorder suggestions from recent sales.',
      ],
      [
        'Orders and PayPal links',
        'Describe a sale and Katale drafts the order with the catalogue price. A one-time code sends the PayPal link.',
      ],
      [
        'Voice notes',
        'Speak the order while you work. Katale transcribes it and reads back anything it is unsure of.',
      ],
      [
        'Alerts, reports and charts',
        'Low-stock and payment alerts as they happen, a daily or weekly summary, and charts on request.',
      ],
      [
        'Shipping and disputes',
        'Add tracking that goes to PayPal, and answer PayPal disputes, each approved with its own code.',
      ],
    ],
  },
  {
    title: 'For your customers',
    items: [
      [
        'A shop on your WhatsApp number',
        'Customers browse a numbered catalogue with photos and see availability, never your stock counts.',
      ],
      [
        'Cart and checkout',
        'They add items, choose delivery or pickup and pay with PayPal. The cart and total are always built by the shop.',
      ],
      [
        'Order status and a real person',
        'They can check their orders any time, or ask for a person and the assistant steps aside.',
      ],
    ],
  },
];

const COMPARISON = [
  [
    'Where you work',
    'A web app or a new phone app to learn',
    'WhatsApp, which you and your customers already use',
  ],
  ['How you ask', 'Menus, forms and reports', 'Plain English, typed or spoken'],
  [
    'Prices and totals',
    'Worked out by hand or in a spreadsheet',
    'Computed by the backend from your catalogue; the AI never sets a price',
  ],
  [
    'Getting paid',
    'Payment details sent by hand, then checked later',
    'A PayPal link from the chat; the order marks itself paid',
  ],
  [
    'Approving money',
    'One tap, easy to get wrong',
    'A one-time code that works only for that exact action',
  ],
  [
    'Knowing how it’s going',
    'Log in and look',
    'Alerts and a sales report with a chart, in the chat',
  ],
];

export default async function HomePage() {
  const [user, chat, origin] = await Promise.all([currentUser(), publicWhatsApp(), siteUrl()]);
  const dashboard = user
    ? { href: DASHBOARD_HOME, label: 'Open dashboard' }
    : { href: '/login', label: 'Merchant login' };
  const chatUrl = `${origin}/chat`;

  return (
    <>
      {/* ─── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className={s.glow} aria-hidden />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-12 sm:px-8 md:pt-20 lg:grid-cols-[1.2fr_0.8fr] lg:gap-14 lg:pb-28">
          <div>
            <h1 className={`${s.display} text-[clamp(2.75rem,6.2vw,4.4rem)]`}>
              Your business. One conversation away.
            </h1>
            <p className={`${s.lede} mt-6 max-w-[34rem] text-lg leading-relaxed sm:text-xl`}>
              Katale AI runs your shop from WhatsApp. Take orders by voice or text, send PayPal
              payment links, keep stock right and see how the week went. The AI prepares, you
              approve, PayPal executes.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              {chat.available ? (
                <Link href="/chat" className={`${s.btn} ${s.btnPrimary}`}>
                  <WhatsAppIcon />
                  Chat on WhatsApp
                </Link>
              ) : (
                <Link href="#demo" className={`${s.btn} ${s.btnPrimary}`}>
                  See it in a conversation
                </Link>
              )}
              <Link href={dashboard.href} className={`${s.btn} ${s.btnGhost}`}>
                {dashboard.label}
              </Link>
            </div>
            <p className={`${s.muted} mt-6 text-sm`}>
              Built in Uganda for small sellers across East Africa.
            </p>
          </div>
          <div className="mx-auto w-full max-w-[25rem] lg:mr-0">
            <Conversation script={heroScript} height={600} />
          </div>
        </div>
      </section>

      {/* ─── How it works ─────────────────────────────────────────────────── */}
      <section id="how" className={`${s.rule} scroll-mt-16`}>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
          <h2 className={`${s.display} max-w-2xl text-[clamp(2.1rem,4.6vw,3.4rem)]`}>
            From a chat message to a paid order
          </h2>
          <p className={`${s.lede} mt-4 max-w-xl text-lg`}>
            Four steps, all in the conversation you already have open.
          </p>
          <ol className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
            {STEPS.map((step, i) => (
              <li key={step.title} className="relative">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--leaf)] font-[family-name:var(--font-display)] text-base font-bold text-white">
                    {i + 1}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span aria-hidden className="hidden h-px flex-1 bg-[var(--line)] lg:block" />
                  )}
                </div>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className={`${s.lede} mt-2 text-[0.95rem] leading-relaxed`}>{step.body}</p>
                <p className="mt-4 inline-block rounded-xl rounded-tr-sm bg-[var(--bubble-out)] px-3 py-1.5 text-sm">
                  {step.example}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Features ─────────────────────────────────────────────────────── */}
      <section id="features" className={`${s.rule} scroll-mt-16 bg-[var(--surface)]`}>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
          <h2 className={`${s.display} max-w-3xl text-[clamp(2.1rem,4.6vw,3.4rem)]`}>
            Everything a small shop runs on, in one chat
          </h2>
          <div className="mt-14 grid gap-14 lg:grid-cols-2 lg:gap-16">
            {FEATURE_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="text-sm font-semibold text-[var(--leaf)]">{group.title}</h3>
                <dl className="mt-4">
                  {group.items.map(([name, text]) => (
                    <div key={name} className={`${s.rule} py-5`}>
                      <dt className="text-[1.05rem] font-semibold tracking-tight">{name}</dt>
                      <dd className={`${s.lede} mt-1.5 leading-relaxed`}>{text}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          <div className="mt-20 grid items-center gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-12">
            <div>
              <h3 className="text-sm font-semibold text-[var(--leaf)]">On the dashboard</h3>
              <p className={`${s.display} mt-3 text-[clamp(1.7rem,3vw,2.3rem)]`}>
                Every order, payment and decision, traceable
              </p>
              <p className={`${s.lede} mt-4 leading-relaxed`}>
                Orders, payments, disputes and customers in AG Grid tables you can filter, edit and
                export. Analytics you can reshape by asking. And an activity trace that shows each
                step, from the message to the AI&apos;s decision, your approval and PayPal.
              </p>
            </div>
            <DashboardPreview />
          </div>
        </div>
      </section>

      {/* ─── Demo ─────────────────────────────────────────────────────────── */}
      <section id="demo" className={`${s.rule} scroll-mt-16`}>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className={`${s.display} text-[clamp(2.1rem,4.6vw,3.4rem)]`}>
              See it in a real conversation
            </h2>
            <p className={`${s.lede} mt-4 text-lg`}>
              Pick a workflow to play it. These are examples with sample data from a demo shop; the
              green notes show what Katale does behind each message.
            </p>
          </div>
          <div className="mt-10">
            <Demo />
          </div>
        </div>
      </section>

      {/* ─── WhatsApp QR ──────────────────────────────────────────────────── */}
      <section id="chat" className={`${s.rule} scroll-mt-16 bg-[var(--surface)]`}>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 md:grid-cols-[1fr_auto] lg:py-28">
          <div className="max-w-xl">
            <h2 className={`${s.display} text-[clamp(2.1rem,4.6vw,3.4rem)]`}>
              {chat.available ? 'Try it on your phone' : 'Chat opens soon'}
            </h2>
            {chat.available ? (
              <>
                <p className={`${s.lede} mt-4 text-lg leading-relaxed`}>
                  Scan the code with your phone&apos;s camera to open WhatsApp, then send{' '}
                  <strong className="font-semibold text-[var(--ink)]">hi</strong>. You&apos;ll shop
                  the demo store as a customer: browse, add to a cart and check out.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <Link href="/chat" className={`${s.btn} ${s.btnPrimary}`}>
                    <WhatsAppIcon />
                    Open WhatsApp
                  </Link>
                  <span className={`${s.muted} text-sm`}>
                    or message{' '}
                    <span className="font-medium tabular-nums text-[var(--ink)]">
                      {displayPhone(chat.phone)}
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <p className={`${s.lede} mt-4 text-lg leading-relaxed`}>
                The demo shop&apos;s WhatsApp number isn&apos;t published right now. Play the
                example conversations above, or sign in if you run a Katale shop.
              </p>
            )}
          </div>
          {chat.available && (
            <div className="mx-auto w-56 sm:w-64">
              <div className={s.qrFrame}>
                <QrCode url={chatUrl} label="QR code that opens a WhatsApp chat with Katale AI" />
              </div>
              <p className={`${s.muted} mt-3 text-center text-xs`}>
                {chatUrl.replace(/^https?:\/\//, '')}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ─── Why ──────────────────────────────────────────────────────────── */}
      <section id="why" className={`${s.rule} scroll-mt-16`}>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
          <h2 className={`${s.display} max-w-3xl text-[clamp(2.1rem,4.6vw,3.4rem)]`}>
            Business software, rebuilt around the chat
          </h2>
          <p className={`${s.lede} mt-4 max-w-2xl text-lg`}>
            Small shops already sell in conversations. Katale keeps the conversation and adds the
            back office, with code, not the AI, in charge of the money.
          </p>
          <div className="mt-12 overflow-x-auto">
            <table className={`${s.compare} w-full min-w-[640px] text-[0.95rem]`}>
              <thead>
                <tr className="text-sm">
                  <th scope="col" className="w-[22%] font-medium">
                    <span className="sr-only">Topic</span>
                  </th>
                  <th scope="col" className={`${s.muted} w-[36%] font-medium`}>
                    The usual way
                  </th>
                  <th scope="col" className="font-semibold text-[var(--leaf)]">
                    With Katale AI
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map(([topic, usual, katale]) => (
                  <tr key={topic}>
                    <th scope="row" className="font-semibold">
                      {topic}
                    </th>
                    <td className={s.muted}>{usual}</td>
                    <td>{katale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ─── Final call to action ─────────────────────────────────────────── */}
      <section className={s.deep}>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
          <h2 className={`${s.display} max-w-3xl text-[clamp(2.4rem,6vw,4.4rem)]`}>
            Open WhatsApp and say hi.
          </h2>
          <p className="mt-5 max-w-xl text-lg text-white/80">
            See the shop from your customer&apos;s side in under a minute, or sign in to run your
            own.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href={chat.available ? '/chat' : '#demo'} className={`${s.btn} ${s.btnOnDeep}`}>
              {chat.available ? (
                <>
                  <WhatsAppIcon />
                  Chat on WhatsApp
                </>
              ) : (
                'Play the demo'
              )}
            </Link>
            <Link href={dashboard.href} className={`${s.btn} ${s.btnOutlineOnDeep}`}>
              {dashboard.label}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
