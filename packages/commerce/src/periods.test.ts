import { describe, expect, it } from 'vitest';
import { previousPeriod, resolvePeriod, zonedMidnight } from './periods';

describe('resolvePeriod', () => {
  // Wednesday 2026-10-07 10:00 in Kampala (UTC+3) = 07:00 UTC
  const now = new Date('2026-10-07T07:00:00Z');

  it('computes local midnight in the merchant timezone', () => {
    expect(zonedMidnight(2026, 10, 7, 'Africa/Kampala').toISOString()).toBe(
      '2026-10-06T21:00:00.000Z',
    );
  });

  it('resolves "today" and "this week" (Monday start)', () => {
    expect(resolvePeriod('today', now, 'Africa/Kampala').start?.toISOString()).toBe(
      '2026-10-06T21:00:00.000Z',
    );
    expect(resolvePeriod('this_week', now, 'Africa/Kampala').start?.toISOString()).toBe(
      '2026-10-04T21:00:00.000Z',
    );
    expect(resolvePeriod('this_month', now, 'Africa/Kampala').start?.toISOString()).toBe(
      '2026-09-30T21:00:00.000Z',
    );
  });

  it('handles DST timezones', () => {
    // 2026-03-29 is the EU DST switch; midnight is still UTC+1 (CET).
    expect(zonedMidnight(2026, 3, 29, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(zonedMidnight(2026, 3, 30, 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
  });

  it('treats all_time as unbounded', () => {
    expect(resolvePeriod('all_time', now, 'UTC').start).toBeNull();
  });
});

describe('previousPeriod', () => {
  // Wednesday 2026-10-14 15:00 in Kampala (UTC+3) = 12:00 UTC.
  const now = new Date('2026-10-14T12:00:00Z');
  const tz = 'Africa/Kampala';

  it('compares this week so far with last week up to the same point', () => {
    const p = previousPeriod('this_week', now, tz)!;
    expect(p.start!.toISOString()).toBe('2026-10-04T21:00:00.000Z'); // Mon 5 Oct 00:00 local
    expect(p.end.toISOString()).toBe('2026-10-07T12:00:00.000Z'); // Wed 7 Oct 15:00 local
  });

  it('compares this month so far with last month up to the same day', () => {
    const p = previousPeriod('this_month', now, tz)!;
    expect(p.start!.toISOString()).toBe('2026-08-31T21:00:00.000Z'); // 1 Sep local
    expect(p.end.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('has no comparison for all time', () => {
    expect(previousPeriod('all_time', now, tz)).toBeNull();
  });

  it('last_month is the whole previous calendar month, compared with the month before', () => {
    const now = new Date('2026-03-10T09:00:00Z'); // Kampala, UTC+3
    const tz = 'Africa/Kampala';
    expect(resolvePeriod('last_month', now, tz)).toEqual({
      start: new Date('2026-01-31T21:00:00Z'),
      end: new Date('2026-02-28T21:00:00Z'),
      label: 'last month (February 2026)',
    });
    // January has 31 days: the comparison covers all of it, not just 28 days.
    expect(previousPeriod('last_month', now, tz)).toEqual({
      start: new Date('2025-12-31T21:00:00Z'),
      end: new Date('2026-01-31T21:00:00Z'),
      label: 'the month before (January)',
    });
  });
});
