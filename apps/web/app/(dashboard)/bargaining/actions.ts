'use server';

import { revalidatePath } from 'next/cache';
import { apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type BundleFormState = { ok: boolean; message: string } | null;

/** Saves the shop's bundle discount ("N different products together, X% off"), or turns it off. */
export async function saveBundle(_prev: BundleFormState, form: FormData): Promise<BundleFormState> {
  await requireUser();
  const enabled = form.get('enabled') === 'on';
  const minItems = Number(String(form.get('minItems') ?? ''));
  const percentOff = Number(String(form.get('percentOff') ?? '').replace(/%$/, ''));
  if (
    enabled &&
    (!Number.isInteger(minItems) ||
      minItems < 2 ||
      minItems > 20 ||
      !Number.isInteger(percentOff) ||
      percentOff < 1 ||
      percentOff > 90)
  )
    return {
      ok: false,
      message: 'Choose 2 to 20 different products and a whole percentage from 1 to 90.',
    };
  const result = await apiPut('/api/pricing/bundle', {
    bundle: enabled ? { minItems, percentOff } : null,
  });
  if (!result.ok) return { ok: false, message: result.error };
  revalidatePath('/bargaining');
  return {
    ok: true,
    message: enabled
      ? `Saved: ${minItems}+ different bargainable products together get ${percentOff}% off each.`
      : 'Bundle discount turned off.',
  };
}
