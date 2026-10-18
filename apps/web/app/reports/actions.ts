'use server';

import { revalidatePath } from 'next/cache';
import { apiPost, apiPut } from '@/lib/api';
import { requireUser } from '@/lib/auth';

export type ActionState = { ok: boolean; message: string } | null;

const SECTIONS = [
  'includeSales',
  'includeInventory',
  'includeUnpaid',
  'includeDisputes',
  'includeChart',
  'includeInsights',
] as const;

export async function saveSchedule(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const [hour, minute] = String(form.get('time') ?? '08:00')
    .split(':')
    .map(Number);
  const timezone = String(form.get('timezone') ?? '').trim();
  const result = await apiPut('/api/reports/schedule', {
    enabled: form.get('enabled') === 'on',
    frequency:
      (['DAILY', 'WEEKLY', 'MONTHLY'] as const).find((f) => f === form.get('frequency')) ??
      'WEEKLY',
    weekday: Number(form.get('weekday') ?? 1),
    hour: Number.isFinite(hour) ? hour : 8,
    minute: Number.isFinite(minute) ? minute : 0,
    timezone: timezone || null,
    ...Object.fromEntries(SECTIONS.map((s) => [s, form.get(s) === 'on'])),
  });
  revalidatePath('/reports');
  return result.ok
    ? { ok: true, message: 'Schedule saved.' }
    : { ok: false, message: result.error };
}

export async function sendReportNow(): Promise<ActionState> {
  await requireUser();
  const result = await apiPost<{ status: string; deliveries: number }>('/api/reports/send-now', {});
  revalidatePath('/reports');
  if (!result.ok) return { ok: false, message: result.error };
  const { status, deliveries } = result.data;
  if (!deliveries)
    return {
      ok: false,
      message: 'No active admin receives reports. Turn on reports for an admin first.',
    };
  return status === 'SENT'
    ? { ok: true, message: `Report sent to ${deliveries} admin${deliveries === 1 ? '' : 's'}.` }
    : {
        ok: false,
        message: `Report ${status.toLowerCase()} — failed deliveries are retried automatically.`,
      };
}
