'use client';

import { useActionState, useState, useTransition } from 'react';
import { saveSchedule, sendReportNow, type ActionState } from './actions';

export interface Schedule {
  enabled: boolean;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  weekday: number;
  hour: number;
  minute: number;
  timezone: string | null;
  includeSales: boolean;
  includeInventory: boolean;
  includeUnpaid: boolean;
  includeDisputes: boolean;
  includeChart: boolean;
  includeInsights: boolean;
  merchantTimezone: string;
  nextAt: string | null;
  recipients: number;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SECTIONS: [keyof Schedule, string][] = [
  ['includeSales', 'Sales and comparison with the previous period'],
  ['includeInventory', 'Low and out-of-stock products'],
  ['includeUnpaid', 'Unpaid PayPal links'],
  ['includeDisputes', 'Open PayPal disputes'],
  ['includeChart', '7-day revenue chart (image)'],
  ['includeInsights', 'Recommended actions'],
];
const field =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';

function Notice({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

export function ScheduleForm({ schedule }: { schedule: Schedule }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSchedule, null);
  const [frequency, setFrequency] = useState(schedule.frequency);
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  return (
    <form action={action} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <input type="checkbox" name="enabled" defaultChecked={schedule.enabled} />
        Send scheduled reports on WhatsApp
      </label>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="mb-1 block font-medium text-slate-700">How often</span>
          <select
            name="frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Schedule['frequency'])}
            className={field}
          >
            <option value="WEEKLY">Weekly</option>
            <option value="DAILY">Daily</option>
            <option value="MONTHLY">Monthly</option>
          </select>
        </label>
        {frequency === 'WEEKLY' ? (
          <label>
            <span className="mb-1 block font-medium text-slate-700">Day</span>
            <select name="weekday" defaultValue={schedule.weekday} className={field}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <input type="hidden" name="weekday" value={schedule.weekday} />
            {frequency === 'MONTHLY' && (
              <p className="self-center pb-1.5 text-slate-600">on the 1st, covering last month</p>
            )}
          </>
        )}
        <label>
          <span className="mb-1 block font-medium text-slate-700">Time</span>
          <input type="time" name="time" defaultValue={time} required className={field} />
        </label>
        <label>
          <span className="mb-1 block font-medium text-slate-700">Time zone</span>
          <input
            name="timezone"
            defaultValue={schedule.timezone ?? ''}
            placeholder={schedule.merchantTimezone}
            className={`${field} w-56`}
          />
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Include</legend>
        <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          {SECTIONS.map(([name, label]) => (
            <label key={name} className="flex items-center gap-2">
              <input type="checkbox" name={name} defaultChecked={Boolean(schedule[name])} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save schedule'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function SendNowButton({ disabled }: { disabled: boolean }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending || disabled}
        onClick={() => start(async () => setState(await sendReportNow()))}
        className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Send report now'}
      </button>
      <Notice state={state} />
    </div>
  );
}
