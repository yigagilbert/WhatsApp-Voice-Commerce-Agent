import Image from 'next/image';
import logo from '@/components/katale-logo.png';

const ORDERS = [
  ['ORD-7K2Q', 'Sarah N.', 'Voice', '3 × Handmade Basket', '$41.00', 'Paid', 'Shipped'],
  ['ORD-6SUG', 'Amina K.', 'Text', '2 × Barkcloth Wallet, 1 × Basket', '$48.00', 'Paid', 'To ship'],
  ['ORD-5Q1M', 'Joel O.', 'Voice', '1 × Coffee Gift Pack', '$25.00', 'Link sent', '—'],
  ['ORD-4ZT8', 'Grace A.', 'Text', '4 × Handmade Basket', '$53.00', 'Paid', 'Delivered'],
  ['ORD-3HC2', 'Peter M.', 'Voice', '1 × Barkcloth Wallet', '$18.00', 'Refunded', '—'],
];

const NAV = ['Overview', 'Orders', 'Payments', 'Disputes', 'Products', 'Analytics', 'Activity'];

const pill = (value: string) =>
  value === 'Paid' || value === 'Delivered'
    ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20'
    : value === 'Shipped' || value === 'To ship'
      ? 'bg-sky-50 text-sky-800 ring-sky-600/20'
      : value === 'Link sent'
        ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
        : value === 'Refunded'
          ? 'bg-slate-100 text-slate-700 ring-slate-500/20'
          : 'text-slate-400 ring-transparent';

/**
 * The merchant dashboard's Orders page, drawn in code with sample orders (sharp at any size and
 * readable in dark mode, unlike a screenshot). Same columns and badges as the real grid.
 */
export function DashboardPreview() {
  return (
    <figure
      className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white text-slate-900 shadow-[0_30px_80px_-40px_rgb(28_35_41/0.45)]"
      aria-label="The merchant dashboard's Orders page with sample orders"
    >
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-slate-300" />
        <span className="size-2.5 rounded-full bg-slate-300" />
        <span className="size-2.5 rounded-full bg-slate-300" />
        <span className="ml-3 rounded-md bg-white px-3 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200">
          kataleai.space/orders
        </span>
      </div>
      <div className="flex">
        <aside className="hidden w-36 shrink-0 border-r border-slate-200 p-3 2xl:block">
          <div className="mb-3 flex items-center gap-1.5 px-2">
            <Image src={logo} alt="" unoptimized className="h-5 w-auto" />
            <span className="text-xs font-semibold">
              Katale <span className="text-green-700">AI</span>
            </span>
          </div>
          {NAV.map((n) => (
            <div
              key={n}
              className={`rounded-md px-2 py-1.5 text-[11px] font-medium ${
                n === 'Orders' ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              {n}
            </div>
          ))}
        </aside>
        <div className="min-w-0 flex-1 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold">Orders</p>
            <p className="text-[11px] text-slate-500">Sample data</p>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              ['Revenue this week', '$412.00'],
              ['Paid orders', '14'],
              ['From voice notes', '65%'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-slate-200 p-2.5">
                <p className="text-[10px] text-slate-500">{k}</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">{v}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[560px] whitespace-nowrap text-left text-[11px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {['Order', 'Customer', 'Source', 'Items', 'Amount', 'Payment', 'Fulfillment'].map(
                    (h) => (
                      <th key={h} scope="col" className="px-2.5 py-2 font-medium">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {ORDERS.map((o) => (
                  <tr key={o[0]} className="border-t border-slate-100">
                    <td className="px-2.5 py-2 font-medium text-sky-700">{o[0]}</td>
                    <td className="px-2.5 py-2">{o[1]}</td>
                    <td className="px-2.5 py-2 text-slate-600">{o[2]}</td>
                    <td className="max-w-36 truncate px-2.5 py-2 text-slate-600">{o[3]}</td>
                    <td className="px-2.5 py-2 tabular-nums">{o[4]}</td>
                    {[o[5]!, o[6]!].map((v, i) => (
                      <td key={i} className="px-2.5 py-2">
                        <span
                          className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${pill(v)}`}
                        >
                          {v}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </figure>
  );
}
