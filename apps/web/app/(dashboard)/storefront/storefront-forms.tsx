'use client';

import { useState } from 'react';
import { DraftRestored, useFormAction } from '@/components/use-form-action';
import type { StorefrontSettings } from '@/lib/types';
import { removeLogo, saveStorefront, uploadLogo, type StorefrontState } from './actions';

const field =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';
const button =
  'rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50';

function Notice({ state }: { state: StorefrontState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

export function StorefrontForm({
  settings,
  origin,
}: {
  settings: StorefrontSettings;
  origin: string;
}) {
  const { state, pending, restored, formProps } = useFormAction<StorefrontState>(
    saveStorefront,
    null,
    {
      draftKey: 'storefront',
      confirm: (form) => {
        const publish = form.get('enabled') === 'on';
        if (publish && !settings.enabled)
          return 'Publish your storefront? Anyone with the link can browse your products.';
        if (!publish && settings.enabled)
          return 'Make your storefront private? Customers with the link will no longer see it.';
        if (publish && settings.saved && form.get('slug') !== settings.slug)
          return 'Change your shop address? Links and QR codes you already shared stop working.';
        return null;
      },
    },
  );
  const [slug, setSlug] = useState(settings.slug);
  return (
    <form {...formProps} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <DraftRestored show={restored} />
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={settings.enabled}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium text-slate-900">Publish my storefront</span>
          <span className="block text-slate-500">
            Anyone with the link can browse your products. Turn this off to make the shop private
            again.
          </span>
        </span>
      </label>
      <div className="text-sm">
        <label htmlFor="sf-slug" className="mb-1 block font-medium text-slate-700">
          Shop address
        </label>
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-slate-500">{origin}/shop/</span>
          <input
            id="sf-slug"
            name="slug"
            required
            minLength={3}
            maxLength={60}
            pattern="[a-z0-9][a-z0-9\-]{1,58}[a-z0-9]"
            title="Lowercase letters, numbers and hyphens"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className={field}
          />
        </div>
        {settings.saved && slug !== settings.slug && (
          <p className="mt-1 text-amber-700">
            Links and QR codes you already shared stop working if you change this.
          </p>
        )}
      </div>
      <div className="text-sm">
        <label htmlFor="sf-tagline" className="mb-1 block font-medium text-slate-700">
          Tagline
        </label>
        <input
          id="sf-tagline"
          name="tagline"
          maxLength={120}
          defaultValue={settings.tagline ?? ''}
          placeholder="Handmade in Kampala, ordered on WhatsApp"
          className={field}
        />
      </div>
      <div className="text-sm">
        <label htmlFor="sf-about" className="mb-1 block font-medium text-slate-700">
          About your shop
        </label>
        <textarea
          id="sf-about"
          name="about"
          rows={3}
          maxLength={600}
          defaultValue={settings.about ?? ''}
          className={field}
        />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Saving…' : 'Save storefront'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function LogoForm({ settings }: { settings: StorefrontSettings }) {
  const { state, pending, formProps } = useFormAction<StorefrontState>(uploadLogo, null, {
    resetOnSuccess: true,
  });
  return (
    <form {...formProps} className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">Logo</h2>
      <div className="flex items-center gap-4">
        {settings.logoVersion ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by our own route
          <img
            src={`/shop/${settings.slug}/api/logo?v=${settings.logoVersion}&preview=1`}
            alt="Your logo"
            width={56}
            height={56}
            className="h-14 w-14 rounded-lg object-cover"
          />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">
            None
          </span>
        )}
        <input
          type="file"
          name="logo"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Logo image"
          className="min-w-0 text-sm"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Saving…' : 'Save logo'}
        </button>
        {settings.logoVersion && (
          <button
            type="button"
            className="text-sm text-slate-600 underline"
            onClick={() => {
              if (window.confirm('Remove your logo from the storefront?')) void removeLogo();
            }}
          >
            Remove logo
          </button>
        )}
        <Notice state={state} />
      </div>
    </form>
  );
}
