import { describe, expect, it } from 'vitest';
import { latestSlot, nextSlot } from './schedule';

const tz = 'Africa/Kampala'; // UTC+3
const weekly = { frequency: 'WEEKLY' as const, weekday: 1, hour: 8, minute: 0, timeZone: tz };
const daily = { frequency: 'DAILY' as const, weekday: 1, hour: 8, minute: 30, timeZone: tz };

describe('report schedule slots', () => {
  it('weekly: Monday 08:00 local, after the slot → this Monday', () => {
    // Mon 19 Oct 2026 09:00 local = 06:00 UTC
    const slot = latestSlot(weekly, new Date('2026-10-19T06:00:00Z'));
    expect(slot).toEqual({ at: new Date('2026-10-19T05:00:00Z'), periodKey: 'WEEKLY:2026-10-19' });
  });

  it('weekly: before Monday 08:00 → the previous Monday', () => {
    const slot = latestSlot(weekly, new Date('2026-10-19T04:59:00Z'));
    expect(slot.periodKey).toBe('WEEKLY:2026-10-12');
  });

  it('weekly: midweek → this week’s Monday', () => {
    expect(latestSlot(weekly, new Date('2026-10-22T12:00:00Z')).periodKey).toBe(
      'WEEKLY:2026-10-19',
    );
    expect(latestSlot({ ...weekly, weekday: 7 }, new Date('2026-10-22T12:00:00Z')).periodKey).toBe(
      'WEEKLY:2026-10-18',
    );
  });

  it('daily: before and after 08:30 local', () => {
    expect(latestSlot(daily, new Date('2026-10-19T05:29:00Z')).periodKey).toBe('DAILY:2026-10-18');
    expect(latestSlot(daily, new Date('2026-10-19T05:30:00Z'))).toEqual({
      at: new Date('2026-10-19T05:30:00Z'),
      periodKey: 'DAILY:2026-10-19',
    });
  });

  it('next slot follows the latest one', () => {
    expect(nextSlot(weekly, new Date('2026-10-19T06:00:00Z'))).toEqual(
      new Date('2026-10-26T05:00:00Z'),
    );
    expect(nextSlot(daily, new Date('2026-10-19T06:00:00Z'))).toEqual(
      new Date('2026-10-20T05:30:00Z'),
    );
  });

  it('respects other time zones', () => {
    const ny = { ...weekly, timeZone: 'America/New_York' }; // UTC-4 in October
    expect(latestSlot(ny, new Date('2026-10-19T12:30:00Z')).at).toEqual(
      new Date('2026-10-19T12:00:00Z'),
    );
  });

  it('monthly: the 1st of each month in the merchant time zone', () => {
    const spec = {
      frequency: 'MONTHLY' as const,
      weekday: 1,
      hour: 8,
      minute: 0,
      timeZone: 'Africa/Kampala',
    };
    // 17 Oct 2026 → latest slot 1 Oct 08:00 Kampala (05:00 UTC); next 1 Nov.
    const now = new Date('2026-10-17T12:00:00Z');
    expect(latestSlot(spec, now)).toEqual({
      at: new Date('2026-10-01T05:00:00Z'),
      periodKey: 'MONTHLY:2026-10-01',
    });
    expect(nextSlot(spec, now)).toEqual(new Date('2026-11-01T05:00:00Z'));
    // Just before the slot on the 1st: still last month's slot. Across a year boundary too.
    expect(latestSlot(spec, new Date('2026-11-01T04:59:00Z')).periodKey).toBe('MONTHLY:2026-10-01');
    expect(latestSlot(spec, new Date('2027-01-01T03:00:00Z')).periodKey).toBe('MONTHLY:2026-12-01');
  });
});
