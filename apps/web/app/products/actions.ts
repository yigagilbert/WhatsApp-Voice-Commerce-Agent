'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiDelete, apiPatch, apiPost, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { photoProblem } from '@/lib/photo';

export type ProductFormState = { ok: boolean; message: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const wholeNumber = (value: string) => (/^\d+$/.test(value) ? Number(value) : NaN);

/** Uploads the chosen photo (if any) for a product. Returns an error message or null. */
async function uploadPhoto(id: string, form: FormData): Promise<string | null> {
  const file = form.get('photo');
  if (!(file instanceof File) || !file.size) return null;
  const problem = photoProblem(file);
  if (problem) return problem;
  const result = await apiPut(`/api/products/${encodeURIComponent(id)}/image`, {
    dataBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
  });
  return result.ok ? null : `The product was saved, but the photo wasn't: ${result.error}`;
}

/**
 * Creates or updates a product from the editor, then uploads a newly chosen photo. Prices are
 * typed in major units (12.50); stock is a counted total (recorded in the stock ledger on edit).
 */
export async function saveProduct(
  _prev: ProductFormState,
  form: FormData,
): Promise<ProductFormState> {
  await requireUser();
  const id = text(form, 'id');
  const name = text(form, 'name');
  const price = text(form, 'price');
  if (!name) return { ok: false, message: 'Give the product a name.' };
  if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0)
    return { ok: false, message: 'Enter a price such as 12 or 12.50.' };
  const tracked = form.get('trackStock') === 'on';
  const stock = tracked ? wholeNumber(text(form, 'stock') || '0') : null;
  if (tracked && Number.isNaN(stock))
    return { ok: false, message: 'Stock must be a whole number.' };
  const reorderRaw = text(form, 'reorderLevel');
  const reorderLevel = tracked && reorderRaw ? wholeNumber(reorderRaw) : null;
  if (Number.isNaN(reorderLevel))
    return { ok: false, message: 'The low-stock alert level must be a whole number.' };
  const common = {
    name,
    unitPrice: price,
    description: text(form, 'description') || null,
    visibleToCustomers: form.get('visibleToCustomers') === 'on',
    reorderLevel,
  };

  if (!id) {
    const created = await apiPost<{ id: string }>('/api/products', {
      ...common,
      sku: text(form, 'sku') || undefined,
      ...(stock !== null ? { stockQuantity: stock } : {}),
    });
    if (!created.ok) return { ok: false, message: created.error };
    const photoError = await uploadPhoto(created.data.id, form);
    revalidatePath('/products');
    redirect(
      `/products/${encodeURIComponent(created.data.id)}?saved=${photoError ? 'photo-failed' : 'created'}`,
    );
  }

  const updated = await apiPatch(`/api/products/${encodeURIComponent(id)}`, {
    ...common,
    sku: text(form, 'sku') || null,
    active: form.get('active') === 'on',
    ...(stock !== null ? { stockQuantity: stock } : {}),
  });
  if (!updated.ok) return { ok: false, message: updated.error };
  const photoError = await uploadPhoto(id, form);
  revalidatePath('/products');
  revalidatePath(`/products/${id}`);
  return photoError ? { ok: false, message: photoError } : { ok: true, message: 'Saved.' };
}

export async function removeProductPhoto(id: string): Promise<ProductFormState> {
  await requireUser();
  const result = await apiDelete(`/api/products/${encodeURIComponent(id)}/image`);
  revalidatePath('/products');
  revalidatePath(`/products/${id}`);
  return result.ok ? { ok: true, message: 'Photo removed.' } : { ok: false, message: result.error };
}
