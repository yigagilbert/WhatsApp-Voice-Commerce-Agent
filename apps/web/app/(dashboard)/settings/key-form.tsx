'use client';

import { useActionState, useEffect, useRef } from 'react';
import { removeKey, saveKey, type KeyActionState } from './actions';

export interface KeyStatus {
  name: string;
  source: 'dashboard' | 'environment' | 'none';
  unreadable: boolean;
  hint: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const STATE: Record<KeyStatus['source'], { text: string; className: string }> = {
  dashboard: { text: 'Set here', className: 'bg-leaf-50 text-leaf-800 ring-leaf-200' },
  environment: {
    text: 'From server .env',
    className: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
  none: { text: 'Not set', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
};

/** A key's status and a write-only field: saved values are never sent back to the browser. */
export function KeyForm({
  status,
  label,
  help,
  whenMissing,
}: {
  status: KeyStatus;
  label: string;
  help: React.ReactNode;
  whenMissing: string;
}) {
  const [saved, save, saving] = useActionState<KeyActionState, FormData>(saveKey, null);
  const [removed, remove, removing] = useActionState<KeyActionState, FormData>(removeKey, null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (saved?.ok) form.current?.reset();
  }, [saved]);
  const message = saved ?? removed;
  const state = STATE[status.source];

  return (
    <section className="rounded-2xl border border-mist bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-charcoal">{label}</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${state.className}`}
        >
          {state.text}
          {status.hint ? ` · ends in ${status.hint}` : ''}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">{help}</p>
      {status.source === 'none' && <p className="mt-1 text-sm text-slate-600">{whenMissing}</p>}
      {status.unreadable && (
        <p role="alert" className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          The saved key can no longer be read because the server&apos;s encryption key changed.
          Enter it again.
        </p>
      )}
      {status.updatedAt && (
        <p className="mt-1 text-xs text-slate-500">
          Updated {new Date(status.updatedAt).toLocaleString('en-GB')}
          {status.updatedBy ? ` by ${status.updatedBy.replace('dashboard:', '')}` : ''}
        </p>
      )}
      <form ref={form} action={save} className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="name" value={status.name} />
        <label className="min-w-0 flex-1 basis-64">
          <span className="sr-only">New {label}</span>
          <input
            name="value"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            placeholder={
              status.source === 'none' ? 'Paste the key' : 'Paste a new key to replace it'
            }
            className="w-full rounded-lg border border-mist px-3 py-2 text-base outline-none focus:border-leaf-500 focus:ring-2 focus:ring-leaf-100 sm:text-sm"
          />
        </label>
        <button
          disabled={saving}
          className="rounded-lg bg-leaf-700 px-4 py-2 text-sm font-medium text-white hover:bg-leaf-800 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
      {status.source === 'dashboard' && (
        <form action={remove} className="mt-2">
          <input type="hidden" name="name" value={status.name} />
          <button
            disabled={removing}
            className="text-xs font-medium text-slate-500 hover:text-red-700 hover:underline"
          >
            Remove this key
          </button>
        </form>
      )}
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`mt-2 text-sm ${message.ok ? 'text-leaf-800' : 'text-red-700'}`}
        >
          {message.message}
        </p>
      )}
    </section>
  );
}
