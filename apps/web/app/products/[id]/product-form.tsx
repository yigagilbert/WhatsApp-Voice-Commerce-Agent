'use client';

import { useActionState, useState, useTransition } from 'react';
import { removePhoto, saveProductDetails, uploadPhoto, type ActionState } from './actions';

function Notice({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

const button =
  'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50';

export function ProductDetailsForm(props: {
  id: string;
  description: string | null;
  visibleToCustomers: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveProductDetails, null);
  return (
    <form action={action} className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      <input type="hidden" name="id" value={props.id} />
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Description for customers</span>
        <textarea
          name="description"
          rows={4}
          maxLength={1000}
          defaultValue={props.description ?? ''}
          placeholder="Size, material, colours, care… Customers see this on WhatsApp."
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="visibleToCustomers"
          defaultChecked={props.visibleToCustomers}
        />
        Show this product to customers on WhatsApp
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function ProductPhotoForm({ id, hasPhoto }: { id: string; hasPhoto: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(uploadPhoto, null);
  const [removing, start] = useTransition();
  const [removed, setRemoved] = useState<ActionState>(null);
  // A new URL after each save so the browser shows the new photo.
  const version = state?.ok ? state.message + Date.now() : 'initial';
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      {hasPhoto && !removed?.ok ? (
        // eslint-disable-next-line @next/next/no-img-element -- private, auth-proxied image
        <img
          src={`/products/${id}/photo?v=${encodeURIComponent(version)}`}
          alt="Product photo"
          className="h-48 w-48 rounded-md border border-slate-200 object-cover"
        />
      ) : (
        <div className="flex h-48 w-48 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500">
          No photo
        </div>
      )}
      <form action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="id" value={id} />
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png"
          required
          className="text-sm"
        />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Uploading…' : hasPhoto ? 'Replace photo' : 'Upload photo'}
        </button>
        {hasPhoto && !removed?.ok && (
          <button
            type="button"
            disabled={removing}
            onClick={() => start(async () => setRemoved(await removePhoto(id)))}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </form>
      <p className="text-xs text-slate-500">
        JPEG or PNG, up to 1 MB. Sent with the product on WhatsApp.
      </p>
      <Notice state={state ?? removed} />
    </div>
  );
}
