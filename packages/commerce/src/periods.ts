import type { SalesPeriod } from './commands';

export interface DateRange {
  /** Inclusive start (UTC instant). null = unbounded. */
  start: Date | null;
  /** Exclusive end (UTC instant). */
  end: Date;
  label: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** 1 = Monday ... 7 = Sunday */
  isoWeekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function zonedParts(
  date: Date,
  timeZone: string,
): ZonedParts & { hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    isoWeekday: WEEKDAYS[parts.weekday ?? ''] ?? 1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight on the given calendar date in `timeZone` (DST-safe). */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** Resolves a named reporting period to a concrete UTC range in the merchant's timezone. */
export function resolvePeriod(period: SalesPeriod, now: Date, timeZone: string): DateRange {
  const today = zonedParts(now, timeZone);
  const midnight = (offsetDays: number) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
    return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timeZone);
  };

  switch (period) {
    case 'today':
      return { start: midnight(0), end: now, label: 'today' };
    case 'yesterday':
      return { start: midnight(-1), end: midnight(0), label: 'yesterday' };
    case 'this_week':
      return { start: midnight(1 - today.isoWeekday), end: now, label: 'this week (since Monday)' };
    case 'last_7_days':
      return { start: midnight(-6), end: now, label: 'the last 7 days' };
    case 'this_month':
      return { start: midnight(1 - today.day), end: now, label: 'this month' };
    case 'last_30_days':
      return { start: midnight(-29), end: now, label: 'the last 30 days' };
    case 'all_time':
      return { start: null, end: now, label: 'all time' };
  }
}
