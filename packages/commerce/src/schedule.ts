import { zonedMidnight, zonedParts } from './periods';

export interface ScheduleSpec {
  /** MONTHLY reports go out on the 1st of each month. */
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** 1 = Monday … 7 = Sunday (weekly). */
  weekday: number;
  hour: number;
  minute: number;
  timeZone: string;
}

export interface DueSlot {
  /** The UTC instant of the most recent scheduled time at or before `now`. */
  at: Date;
  /** Stable key for duplicate prevention, e.g. "WEEKLY:2026-10-19" (local date of the slot). */
  periodKey: string;
}

const DAY = 86_400_000;

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export const localDate = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);

/**
 * The latest scheduled slot at or before `now` in the schedule's time zone. The scheduler sends a
 * slot once (the period key is unique per merchant) and only while it is recent.
 */
export function latestSlot(spec: ScheduleSpec, now: Date): DueSlot {
  const today = zonedParts(now, spec.timeZone);
  const slotOn = (offsetDays: number) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
    const midnight = zonedMidnight(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      spec.timeZone,
    );
    return new Date(midnight.getTime() + (spec.hour * 60 + spec.minute) * 60_000);
  };
  if (spec.frequency === 'MONTHLY') {
    const firstOf = (year: number, month: number) => {
      const d = new Date(Date.UTC(year, month - 1, 1));
      const midnight = zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, spec.timeZone);
      return new Date(midnight.getTime() + (spec.hour * 60 + spec.minute) * 60_000);
    };
    let at = firstOf(today.year, today.month);
    if (at.getTime() > now.getTime()) at = firstOf(today.year, today.month - 1);
    return { at, periodKey: `MONTHLY:${localDate(at, spec.timeZone)}` };
  }
  let offset = spec.frequency === 'DAILY' ? 0 : -((today.isoWeekday - spec.weekday + 7) % 7);
  let at = slotOn(offset);
  if (at.getTime() > now.getTime()) {
    offset -= spec.frequency === 'DAILY' ? 1 : 7;
    at = slotOn(offset);
  }
  return { at, periodKey: `${spec.frequency}:${localDate(at, spec.timeZone)}` };
}

/** The next slot after `now` (for the dashboard's "next report" line). */
export function nextSlot(spec: ScheduleSpec, now: Date): Date {
  const latest = latestSlot(spec, now).at;
  const step = (spec.frequency === 'DAILY' ? 1 : spec.frequency === 'WEEKLY' ? 7 : 32) * DAY;
  // Re-anchor through latestSlot so DST changes don't drift the wall-clock time.
  return latestSlot(spec, new Date(latest.getTime() + step + 60 * 60_000)).at;
}
