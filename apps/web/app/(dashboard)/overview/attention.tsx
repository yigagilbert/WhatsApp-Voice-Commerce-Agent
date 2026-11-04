import Link from 'next/link';
import type { AttentionItem } from '@/lib/types';

const DOT: Record<AttentionItem['severity'], string> = {
  urgent: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-slate-400',
};
const SEVERITY: Record<AttentionItem['severity'], string> = {
  urgent: 'Urgent',
  warning: 'Soon',
  info: 'For information',
};
const VISIBLE = 3;

/** What needs attention, most pressing first. Every row opens the page where it can be handled. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  const [first, ...rest] = items;
  const shown = rest.slice(0, VISIBLE - 1);
  const more = rest.slice(VISIBLE - 1);

  return (
    <section
      aria-labelledby="attention-heading"
      className="flex min-w-0 flex-col rounded-2xl border border-mist bg-white p-4 sm:p-5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="attention-heading" className="font-display text-base font-semibold text-charcoal">
          Needs attention
        </h2>
        {items.length > 0 && (
          <span className="text-xs tabular-nums text-slate-500">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>

      {!first ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center rounded-full bg-leaf-50 text-leaf-700"
          >
            ✓
          </span>
          <p className="mt-3 text-sm font-medium text-charcoal">You're all caught up</p>
          <p className="mt-1 text-xs text-slate-500">Nothing needs you right now.</p>
        </div>
      ) : (
        <>
          <Link
            href={first.href}
            className="group mt-3 block rounded-xl bg-leaf-50 p-3.5 ring-1 ring-inset ring-leaf-100 transition-colors hover:bg-leaf-100"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-leaf-700">
              Do this next
            </p>
            <p className="mt-1 text-sm font-semibold text-charcoal">{first.title}</p>
            <p className="mt-0.5 text-xs text-slate-600">{first.detail}</p>
            <p className="mt-2 text-xs font-semibold text-leaf-700">
              {first.action}{' '}
              <span
                aria-hidden="true"
                className="inline-block transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </p>
          </Link>
          <ul className="mt-1 divide-y divide-slate-100">
            {shown.map((item) => (
              <AttentionRow key={item.id} item={item} />
            ))}
          </ul>
          {more.length > 0 && (
            <details className="group/more">
              <summary className="cursor-pointer list-none py-2 text-xs font-medium text-slate-500 hover:text-charcoal">
                {more.length} more
              </summary>
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {more.map((item) => (
                  <AttentionRow key={item.id} item={item} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <li>
      <Link
        href={item.href}
        className="group flex items-start gap-2.5 rounded-md py-2.5 transition-colors hover:bg-slate-50"
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[item.severity]}`}
        />
        <span className="min-w-0 flex-1">
          <span className="sr-only">{SEVERITY[item.severity]}: </span>
          <span className="block text-sm font-medium text-charcoal">{item.title}</span>
          <span className="block text-xs text-slate-500">{item.detail}</span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs font-medium text-leaf-700 opacity-80 group-hover:opacity-100">
          {item.action}
        </span>
      </Link>
    </li>
  );
}
