'use client';

import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toMajorString, toMinorUnits } from '@vca/commerce/money';
import { MAX_COUNTER_OFFERS, counterOffer } from '@vca/commerce/bargaining';
import { PHOTO_TYPES, photoProblem, photoUrl } from '@/lib/photo';
import type { ProductDetail } from '@/lib/types';
import { removeProductPhoto, saveProduct, type ProductFormState } from './actions';

const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';
const button =
  'rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy?: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="text-sm">
      <label htmlFor={id} className="mb-1 block font-medium text-slate-700">
        {label}
      </label>
      {children(id, hint ? `${id}-hint` : undefined)}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Photo picker: shows the current photo, previews a newly chosen one before saving (nothing is
 * uploaded until Save), checks type and size immediately, and removes the photo on request.
 */
function PhotoField({
  product,
  onError,
}: {
  product?: ProductDetail;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const current = product?.image ? photoUrl(product.id, product.image.version) : null;
  const shown = preview ?? current;
  // Once a chosen photo is saved (a new version arrives), drop the local preview and the file.
  const version = product?.image?.version ?? null;
  const [seenVersion, setSeenVersion] = useState(version);
  if (version !== seenVersion) {
    setSeenVersion(version);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  const choose = (file: File | undefined) => {
    if (!file) return;
    const problem = photoProblem(file);
    if (problem) {
      onError(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    onError(null);
    setPreview(URL.createObjectURL(file));
  };

  return (
    <div>
      <p className="mb-1 text-sm font-medium text-slate-700">Photo</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="relative flex h-40 w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated, same-origin photo
            <img src={shown} alt="Product photo" className="h-full w-full object-cover" />
          ) : (
            <span className="px-3 text-center text-xs text-slate-500">
              No photo yet. Customers see photos on WhatsApp.
            </span>
          )}
          {preview && (
            <span className="absolute left-1 top-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
              Not saved yet
            </span>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <input
            ref={fileRef}
            type="file"
            name="photo"
            accept={PHOTO_TYPES.join(',')}
            className="sr-only"
            id="product-photo"
            onChange={(e) => choose(e.target.files?.[0])}
          />
          <label htmlFor="product-photo" className={`${button} inline-flex cursor-pointer`}>
            {shown ? 'Replace photo' : 'Choose photo'}
          </label>
          {preview && (
            <button
              type="button"
              className={`${button} ml-2`}
              onClick={() => {
                setPreview(null);
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              Undo
            </button>
          )}
          {!preview && current && product && (
            <button
              type="button"
              disabled={pending}
              className={`${button} ml-2 text-rose-700`}
              onClick={() => {
                if (!window.confirm('Remove this photo? Customers will no longer see it.')) return;
                start(async () => {
                  const result = await removeProductPhoto(product.id);
                  onError(result?.ok ? null : (result?.message ?? 'Could not remove the photo.'));
                  router.refresh();
                });
              }}
            >
              {pending ? 'Removing…' : 'Remove photo'}
            </button>
          )}
          <p className="text-xs text-slate-500">
            JPEG, PNG or WebP up to 8 MB. Katale resizes it, removes location data and makes a
            thumbnail. Saved with the product.
          </p>
        </div>
      </div>
    </div>
  );
}

/** "$30 → $29 → $27 → $25": the offers Katale would make, from typed prices (or null). */
function offerLadder(price: string, min: string, currency: string): string[] | null {
  try {
    const list = toMinorUnits(price, currency);
    const floor = toMinorUnits(min, currency);
    if (floor <= 0 || floor >= list) return null;
    const offers = [list];
    for (let round = 1; round <= MAX_COUNTER_OFFERS; round++) {
      const next = counterOffer(list, floor, round);
      if (next < offers.at(-1)!) offers.push(next);
    }
    const fmt = (m: number) =>
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
        Number(toMajorString(m, currency)),
      );
    return offers.map(fmt);
  } catch {
    return null;
  }
}

/**
 * Bargaining and quantity discounts, in plain words: an on/off switch, the lowest price the
 * merchant accepts (with a preview of the offers Katale would make) and up to three
 * "buy N or more, X% off" rows. Nothing here is shown to customers except the quantity deals.
 */
function PricingFields({
  product,
  currency,
  price,
}: {
  product?: ProductDetail;
  currency: string;
  price: string;
}) {
  const [bargaining, setBargaining] = useState(product?.bargainingEnabled ?? false);
  const [min, setMin] = useState(
    product?.minPriceMinor != null ? toMajorString(product.minPriceMinor, currency) : '',
  );
  const tiers = product?.quantityDiscounts ?? [];
  const ladder = bargaining ? offerLadder(price, min, currency) : null;
  return (
    <fieldset className="space-y-4 rounded-md border border-slate-200 p-4">
      <legend className="px-1 text-sm font-medium text-slate-700">
        Bargaining &amp; discounts
      </legend>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="bargainingEnabled"
          className="mt-0.5"
          checked={bargaining}
          onChange={(e) => setBargaining(e.target.checked)}
        />
        <span>
          <span className="font-medium">Customers can bargain on WhatsApp</span>
          <span className="block text-xs text-slate-500">
            When a customer asks for a better price, Katale AI negotiates politely, never below your
            lowest price. Leave off for a fixed price.
          </span>
        </span>
      </label>
      {bargaining && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={`Lowest price you accept (${currency})`}
            hint="Private: never shown or hinted to customers."
          >
            {(id, hint) => (
              <input
                id={id}
                name="minPrice"
                inputMode="decimal"
                required
                aria-describedby={hint}
                value={min}
                onChange={(e) => setMin(e.target.value)}
                placeholder="e.g. 24.00"
                className={input}
              />
            )}
          </Field>
          <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600" aria-live="polite">
            {ladder ? (
              <>
                <p className="font-medium text-slate-700">How Katale would bargain</p>
                <p className="mt-1 tabular-nums">{ladder.join(' → ')}</p>
                <p className="mt-1">
                  At most {MAX_COUNTER_OFFERS} steps. A customer offer at or above the next step is
                  accepted.
                </p>
              </>
            ) : (
              <p>
                Enter a lowest price below the selling price to see the offers Katale would make.
              </p>
            )}
          </div>
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-slate-700">Quantity discounts (optional)</p>
        <p className="mb-2 text-xs text-slate-500">
          Customers see these. Applied automatically; never combined with other discounts.
        </p>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <span>Buy</span>
              <input
                name={`tierQty${i}`}
                aria-label={`Quantity discount ${i + 1}: minimum units`}
                inputMode="numeric"
                defaultValue={tiers[i]?.minQuantity ?? ''}
                placeholder={String([3, 5, 10][i])}
                className={`${input} w-20`}
              />
              <span>or more →</span>
              <input
                name={`tierPct${i}`}
                aria-label={`Quantity discount ${i + 1}: percent off`}
                inputMode="numeric"
                defaultValue={tiers[i]?.percentOff ?? ''}
                placeholder={String([5, 10, 15][i])}
                className={`${input} w-20`}
              />
              <span>% off each</span>
            </div>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

/** Create or edit a product: details, price, stock, visibility and photo in one form. */
export function ProductEditor({
  product,
  currency,
}: {
  product?: ProductDetail;
  /** Currency for new products (the merchant's). */
  currency: string;
}) {
  const [state, action, pending] = useActionState<ProductFormState, FormData>(saveProduct, null);
  const [, startSubmit] = useTransition();
  // Submitted by hand: a `<form action>` resets every field after the action, so a rejected
  // save would wipe what the merchant typed (and the chosen photo).
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startSubmit(() => action(form));
  };
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [trackStock, setTrackStock] = useState(product ? product.stockQuantity !== null : true);
  const productCurrency = product?.currency ?? currency;
  const [price, setPrice] = useState(
    product ? toMajorString(product.unitPriceMinor, product.currency) : '',
  );
  const editing = !!product;
  const router = useRouter();
  // After a successful edit, drop "?saved=created" so an old banner doesn't linger.
  useEffect(() => {
    if (state?.ok && product && window.location.search) router.replace(`/products/${product.id}`);
  }, [state, product, router]);
  const notice = photoError ? { ok: false, message: photoError } : state;

  return (
    <form onSubmit={submit} className="space-y-5 rounded-lg border border-slate-200 bg-white p-5">
      {product && <input type="hidden" name="id" value={product.id} />}
      <PhotoField product={product} onError={setPhotoError} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              name="name"
              required
              maxLength={200}
              defaultValue={product?.name}
              placeholder="e.g. Handmade Basket"
              className={input}
            />
          )}
        </Field>
        <Field label={`Price (${product?.currency ?? currency})`} hint="Used for every new order.">
          {(id, hint) => (
            <input
              id={id}
              name="price"
              required
              inputMode="decimal"
              aria-describedby={hint}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="12.00"
              className={input}
            />
          )}
        </Field>
      </div>

      <Field label="Category" hint="Groups products on your storefront, for example Baskets.">
        {(id, hint) => (
          <input
            id={id}
            name="category"
            maxLength={60}
            aria-describedby={hint}
            defaultValue={product?.category ?? ''}
            className={input}
          />
        )}
      </Field>

      <Field
        label="Description"
        hint="Shown to customers on WhatsApp and your storefront. Keep it short."
      >
        {(id, hint) => (
          <textarea
            id={id}
            name="description"
            rows={3}
            maxLength={1000}
            aria-describedby={hint}
            defaultValue={product?.description ?? ''}
            className={input}
          />
        )}
      </Field>

      <PricingFields product={product} currency={productCurrency} price={price} />

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
        <legend className="px-1 text-sm font-medium text-slate-700">Stock</legend>
        {!(editing && product.stockQuantity !== null) && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="trackStock"
              checked={trackStock}
              onChange={(e) => setTrackStock(e.target.checked)}
            />
            Track stock for this product
          </label>
        )}
        {editing && product.stockQuantity !== null && (
          <input type="hidden" name="trackStock" value="on" />
        )}
        {trackStock && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Units in stock"
              hint={
                editing
                  ? 'Change this after a count; it is recorded in the stock history. Sales reduce it automatically.'
                  : 'Sales reduce it automatically when a payment completes.'
              }
            >
              {(id, hint) => (
                <input
                  id={id}
                  name="stock"
                  inputMode="numeric"
                  aria-describedby={hint}
                  defaultValue={product?.stockQuantity ?? 0}
                  className={input}
                />
              )}
            </Field>
            <Field label="Low-stock alert at" hint="Admins get a WhatsApp alert at or below this.">
              {(id, hint) => (
                <input
                  id={id}
                  name="reorderLevel"
                  inputMode="numeric"
                  aria-describedby={hint}
                  defaultValue={product?.reorderLevel ?? ''}
                  placeholder="e.g. 10"
                  className={input}
                />
              )}
            </Field>
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SKU (optional)" hint="Your own product code.">
          {(id, hint) => (
            <input
              id={id}
              name="sku"
              maxLength={64}
              aria-describedby={hint}
              defaultValue={product?.sku ?? ''}
              className={input}
            />
          )}
        </Field>
        <div className="space-y-2 pt-6 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="visibleToCustomers"
              defaultChecked={product?.visibleToCustomers ?? true}
            />
            Show to customers on WhatsApp and your storefront
          </label>
          {editing && (
            <label className="flex items-center gap-2">
              <input type="checkbox" name="active" defaultChecked={product.active} />
              Active (can be ordered)
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add product'}
        </button>
        {notice && (
          <p
            role="status"
            className={`text-sm ${notice.ok ? 'text-emerald-700' : 'text-rose-700'}`}
          >
            {notice.message}
          </p>
        )}
      </div>
    </form>
  );
}
