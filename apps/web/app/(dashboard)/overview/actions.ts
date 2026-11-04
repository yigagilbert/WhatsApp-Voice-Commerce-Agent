'use server';

import { apiDelete, apiPut } from '@/lib/api';

export interface LayoutResult {
  error?: string;
}

/** Saves the signed-in person's dashboard. Report state only: no business data is stored with it. */
export async function saveLayout(state: unknown): Promise<LayoutResult> {
  const result = await apiPut('/api/dashboard/layout', { state });
  return result.ok ? {} : { error: result.error };
}

export async function resetLayout(): Promise<LayoutResult> {
  const result = await apiDelete('/api/dashboard/layout');
  return result.ok ? {} : { error: result.error };
}
