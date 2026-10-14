import { describe, expect, it } from 'vitest';
import { resolvePeriod, zonedMidnight } from './periods';

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
