'use client';

import { useActionState, useState } from 'react';
import { saveBundle, type BundleFormState } from './actions';

const input =
  'w-20 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';

/** The shop-wide bundle discount, as one sentence with two numbers and a switch. */
export function BundleForm({
  bundle,
}: {
  bundle: { minItems: number; percentOff: number } | null;
}) {
  const [state, action, pending] = useActionState<BundleFormState, FormData>(saveBundle, null);
  const [enabled, setEnabled] = useState(!!bundle);
  return (
    <form action={action} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          name="enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Bundle discount
      </label>
      <div
        className={`flex flex-wrap items-center gap-2 text-sm text-slate-700 ${enabled ? '' : 'opacity-50'}`}
      >
        <span>When a customer buys</span>
        <input
          name="minItems"
          aria-label="Number of different products"
          inputMode="numeric"
          disabled={!enabled}
          defaultValue={bundle?.minItems ?? 2}
          className={input}
        />
        <span>or more different products together, take</span>
        <input
          name="percentOff"
          aria-label="Percent off"
          inputMode="numeric"
          disabled={!enabled}
          defaultValue={bundle?.percentOff ?? 5}
          className={input}
        />
        <span>% off each.</span>
      </div>
      <p className="text-xs text-slate-500">
        Applies to products open to bargaining. Never combined with quantity discounts or agreed
        prices: each item gets the single best price, and never less than your lowest price.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state && (
          <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
