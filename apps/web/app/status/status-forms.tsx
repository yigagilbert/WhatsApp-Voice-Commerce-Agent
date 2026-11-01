'use client';

import { useActionState, useState, useTransition } from 'react';
import { dateTime } from '@/lib/format';
import {
  editStatusAd,
  generateStatusAd,
  saveStatusSettings,
  statusAdAction,
  type ActionState,
} from './actions';

export interface StatusSettings {
  enabled: boolean;
  weekdays: number[];
  times: string[];
  timezone: string | null;
  approval: 'MANUAL' | 'AUTO';
  publish: 'PHONE' | 'KATALE';
  productIds: string[];
  merchantTimezone: string;
  nextAt: string | null;
  aiCopy: boolean;
  /** Posting by Katale is allowed on this server (STATUS_ADS_POSTING_ENABLED). */
  posting: boolean;
  katalePostsToday: number;
  kataleDailyLimit: number;
  products: { id: string; name: string; eligible: boolean }[];
  ctas: string[];
  themes: string[];
}

export interface StatusAd {
  id: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  scheduledFor: string;
  status: 'DRAFT' | 'READY' | 'POSTED' | 'SKIPPED' | 'FAILED';
  headline: string;
  caption: string;
  cta: string;
  theme: number;
  source: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  approvedBy: string | null;
  postedAt: string | null;
  postedBy: string | null;
  postedVia: 'phone' | 'katale' | null;
  publishingAt: string | null;
  publishError: string | null;
  nextPublishAt: string | null;
  createdAt: string;
  updatedAt: string;
  product: { id: string; name: string } | null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const field =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';
const primary =
  'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50';
const secondary =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

function Notice({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

export function SettingsForm({ settings }: { settings: StatusSettings }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveStatusSettings, null);
  const [scope, setScope] = useState(settings.productIds.length ? 'chosen' : 'all');
  const times = [...settings.times, '', '', ''].slice(0, 3);
  return (
    <form action={action} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
        Prepare Status adverts automatically
      </label>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Days</legend>
        <div className="flex flex-wrap gap-3 text-sm text-slate-700">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="weekdays"
                value={i + 1}
                defaultChecked={settings.weekdays.includes(i + 1)}
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <fieldset>
          <legend className="mb-1 font-medium text-slate-700">Times (up to 3 a day)</legend>
          <div className="flex flex-wrap gap-2">
            {times.map((t, i) => (
              <input
                key={i}
                type="time"
                name="times"
                defaultValue={t}
                required={i === 0}
                aria-label={`Time ${i + 1}`}
                className={field}
              />
            ))}
          </div>
        </fieldset>
        <label>
          <span className="mb-1 block font-medium text-slate-700">Time zone</span>
          <input
            name="timezone"
            defaultValue={settings.timezone ?? ''}
            placeholder={settings.merchantTimezone}
            className={`${field} w-56`}
          />
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">When an advert is ready</legend>
        <div className="space-y-1.5 text-sm text-slate-700">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="approval"
              value="MANUAL"
              defaultChecked={settings.approval === 'MANUAL'}
              className="mt-0.5"
            />
            <span>Keep it as a draft until an admin approves it</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="approval"
              value="AUTO"
              defaultChecked={settings.approval === 'AUTO'}
              className="mt-0.5"
            />
            <span>Mark it ready to post straight away</span>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Who posts it</legend>
        <div className="space-y-1.5 text-sm text-slate-700">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="publish"
              value="PHONE"
              defaultChecked={settings.publish === 'PHONE'}
              className="mt-0.5"
            />
            <span>I download it and post it from the shop phone</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="publish"
              value="KATALE"
              defaultChecked={settings.publish === 'KATALE'}
              disabled={!settings.posting}
              className="mt-0.5"
            />
            <span className={settings.posting ? '' : 'text-slate-400'}>
              Katale posts it to the shop number’s WhatsApp Status once it is ready
              {!settings.posting && ' (turned off on this server)'}
            </span>
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Katale posts at most {settings.kataleDailyLimit} statuses a day and only from this shop’s
          connected number. Posting uses WhatsApp Web, which WhatsApp does not officially support:
          if it fails, the advert stays here for you to post from the phone.
        </p>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Products to promote</legend>
        <div className="mb-2 flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="scope"
              value="all"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            All eligible products
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="scope"
              value="chosen"
              checked={scope === 'chosen'}
              onChange={() => setScope('chosen')}
            />
            Only the products I choose
          </label>
        </div>
        {scope === 'chosen' && (
          <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-md border border-slate-200 p-3 text-sm text-slate-700 sm:grid-cols-2">
            {settings.products.length ? (
              settings.products.map((p) => (
                <label key={p.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="productIds"
                    value={p.id}
                    defaultChecked={settings.productIds.includes(p.id)}
                  />
                  <span className={p.eligible ? '' : 'text-slate-400'}>{p.name}</span>
                  {!p.eligible && <span className="text-xs text-slate-400">not eligible now</span>}
                </label>
              ))
            ) : (
              <p className="text-slate-500">No products yet.</p>
            )}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Only products that are in stock, visible to customers and have a photo are ever promoted.
        </p>
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function GenerateButton() {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setState(await generateStatusAd()))}
        className={primary}
      >
        {pending ? 'Preparing…' : 'Generate an advert now'}
      </button>
      <Notice state={state} />
    </div>
  );
}

const TONE: Record<StatusAd['status'], string> = {
  DRAFT: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  READY: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  POSTED: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  SKIPPED: 'bg-slate-50 text-slate-500 ring-slate-400/20',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};
const LABEL: Record<StatusAd['status'], string> = {
  DRAFT: 'Draft',
  READY: 'Ready to post',
  POSTED: 'Posted',
  SKIPPED: 'Skipped',
  FAILED: 'Failed',
};

export function StatusPill({ status }: { status: StatusAd['status'] }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[status]}`}
    >
      {LABEL[status]}
    </span>
  );
}

function ActionButton({
  id,
  action,
  label,
  primary: isPrimary,
  onDone,
}: {
  id: string;
  action: Parameters<typeof statusAdAction>[1];
  label: string;
  primary?: boolean;
  onDone: (state: ActionState) => void;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => onDone(await statusAdAction(id, action)))}
      className={isPrimary ? primary : secondary}
    >
      {pending ? '…' : label}
    </button>
  );
}

/**
 * An open advert (draft or ready): preview, edit, approve, then download, copy and record as
 * posted, or have Katale post it.
 */
export function OpenAdCard({
  ad,
  ctas,
  themes,
  posting,
}: {
  ad: StatusAd;
  ctas: string[];
  themes: string[];
  posting: boolean;
}) {
  const [state, setState] = useState<ActionState>(null);
  const [editState, editAction, saving] = useActionState<ActionState, FormData>(
    editStatusAd.bind(null, ad.id),
    null,
  );
  const [copied, setCopied] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = `/status/${ad.id}/image?v=${encodeURIComponent(ad.updatedAt)}`;
  return (
    <li className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[180px_1fr]">
      <div>
        {broken ? (
          <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-slate-100 p-3 text-center text-xs text-slate-500">
            Preview unavailable: the product may be out of stock, hidden or without a photo.
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- private, session-authenticated image
          <img
            src={src}
            alt={`Status advert for ${ad.product?.name ?? 'a product'}`}
            className="aspect-[9/16] w-full rounded-md border border-slate-200 object-cover"
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill status={ad.status} />
          <span className="font-medium text-slate-900">{ad.product?.name ?? '—'}</span>
          <span className="text-slate-500">
            {ad.trigger === 'MANUAL' ? 'Generated manually' : 'Scheduled'} ·{' '}
            {ad.source === 'ai' ? 'AI wording' : ad.source === 'edited' ? 'Edited' : 'Template'}
          </span>
        </div>
        <form action={editAction} className="space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Headline (on the image)</span>
            <input
              name="headline"
              defaultValue={ad.headline}
              maxLength={48}
              required
              className={`${field} w-full`}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">
              Caption (paste on WhatsApp)
            </span>
            <textarea
              name="caption"
              defaultValue={ad.caption}
              maxLength={320}
              rows={3}
              required
              className={`${field} w-full`}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label>
              <span className="mb-1 block font-medium text-slate-700">Call to action</span>
              <select name="cta" defaultValue={ad.cta} className={field}>
                {ctas.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block font-medium text-slate-700">Colours</span>
              <select name="theme" defaultValue={ad.theme} className={field}>
                {themes.map((t, i) => (
                  <option key={t} value={i}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={saving} className={secondary}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
          <Notice state={editState} />
        </form>
        <p className="text-xs text-slate-500">
          The price on the image always comes from your catalogue.
        </p>
        {ad.publishingAt ? (
          <p className="text-sm text-slate-600">Katale is posting this advert…</p>
        ) : (
          ad.publishError && (
            <p className="text-sm text-rose-700">
              Katale could not post it: {ad.publishError}
              {ad.nextPublishAt ? ` It tries again ${dateTime(ad.nextPublishAt)}.` : ''}
            </p>
          )
        )}
        <div className="flex flex-wrap items-center gap-2">
          {ad.status === 'DRAFT' && (
            <ActionButton id={ad.id} action="approve" label="Approve" primary onDone={setState} />
          )}
          {ad.status === 'READY' && !ad.publishingAt && (
            <>
              {posting && (
                <ActionButton
                  id={ad.id}
                  action="publish"
                  label="Post to my Status now"
                  primary
                  onDone={setState}
                />
              )}
              <a href={`${src}&download=1`} className={posting ? secondary : primary}>
                Download image
              </a>
              <button
                type="button"
                className={secondary}
                onClick={() =>
                  void navigator.clipboard.writeText(ad.caption).then(() => setCopied(true))
                }
              >
                {copied ? 'Caption copied' : 'Copy caption'}
              </button>
              <ActionButton id={ad.id} action="posted" label="I posted it" onDone={setState} />
            </>
          )}
          {!ad.publishingAt && (
            <ActionButton id={ad.id} action="skip" label="Skip" onDone={setState} />
          )}
        </div>
        {/* A posting failure is already shown above, from the advert itself. */}
        <Notice state={state && !state.ok && state.message === ad.publishError ? null : state} />
      </div>
    </li>
  );
}

export function RetryButton({ id }: { id: string }) {
  const [state, setState] = useState<ActionState>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ActionButton id={id} action="retry" label="Retry" onDone={setState} />
      <Notice state={state} />
    </span>
  );
}
