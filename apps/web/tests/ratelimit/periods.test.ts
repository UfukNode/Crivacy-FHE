/**
 * Monthly period helpers. UTC-only; the tests exercise the boundary
 * cases that matter to the quota counter:
 *   - Midnight UTC on the 1st of a month is the start of that month.
 *   - Just before midnight UTC on the 1st is still the PREVIOUS month.
 *   - December → January year rollover produces the right year.
 *   - A request in the last second of a period gets the period about
 *     to end, and `periodSecondsRemaining` rounds UP so `Retry-After`
 *     never lies.
 */

import { describe, expect, it } from 'vitest';

import {
  RateLimitError,
  getMonthlyPeriod,
  nextPeriod,
  periodMsRemaining,
  periodSecondsRemaining,
  periodToIsoDate,
  periodsEqual,
} from '@/lib/ratelimit';

describe('getMonthlyPeriod', () => {
  it('returns the first instant of the current UTC month', () => {
    const period = getMonthlyPeriod(new Date('2026-03-15T12:00:00Z'));
    expect(period.startAt.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(period.endAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(period.year).toBe(2026);
    expect(period.month).toBe(3);
  });

  it('treats midnight UTC on the 1st as the START of the period (not the end)', () => {
    const period = getMonthlyPeriod(new Date('2026-03-01T00:00:00Z'));
    expect(period.startAt.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(period.month).toBe(3);
  });

  it('treats 23:59:59.999 UTC on the last day as still IN the current period', () => {
    const period = getMonthlyPeriod(new Date('2026-03-31T23:59:59.999Z'));
    expect(period.month).toBe(3);
    expect(period.endAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls year forward on December → January', () => {
    const period = getMonthlyPeriod(new Date('2026-12-31T23:00:00Z'));
    expect(period.year).toBe(2026);
    expect(period.month).toBe(12);
    expect(period.endAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles leap-year February correctly', () => {
    const period = getMonthlyPeriod(new Date('2028-02-29T12:00:00Z'));
    expect(period.month).toBe(2);
    expect(period.endAt.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('rejects a NaN Date', () => {
    expect(() => getMonthlyPeriod(new Date('invalid'))).toThrowError(RateLimitError);
  });
});

describe('periodMsRemaining / periodSecondsRemaining', () => {
  const period = getMonthlyPeriod(new Date('2026-03-15T12:00:00Z'));

  it('returns the exact ms until the period ends', () => {
    const now = new Date('2026-03-31T23:59:59.500Z');
    expect(periodMsRemaining(period, now)).toBe(500);
  });

  it('seconds-remaining rounds UP so Retry-After is safe', () => {
    const now = new Date('2026-03-31T23:59:59.500Z');
    // 500ms remaining → Retry-After: 1 second, not 0.
    expect(periodSecondsRemaining(period, now)).toBe(1);
  });

  it('returns zero on a now past the period end', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    expect(periodMsRemaining(period, now)).toBe(0);
    expect(periodSecondsRemaining(period, now)).toBe(0);
  });

  it('rejects a NaN Date', () => {
    expect(() => periodMsRemaining(period, new Date('nope'))).toThrowError(RateLimitError);
  });
});

describe('periodsEqual', () => {
  it('true for two periods constructed from different instants in the same month', () => {
    const a = getMonthlyPeriod(new Date('2026-03-02T00:00:00Z'));
    const b = getMonthlyPeriod(new Date('2026-03-28T23:59:59Z'));
    expect(periodsEqual(a, b)).toBe(true);
  });

  it('false for adjacent months', () => {
    const a = getMonthlyPeriod(new Date('2026-03-31T23:00:00Z'));
    const b = getMonthlyPeriod(new Date('2026-04-01T00:00:01Z'));
    expect(periodsEqual(a, b)).toBe(false);
  });
});

describe('periodToIsoDate', () => {
  it('renders a Postgres DATE literal', () => {
    const period = getMonthlyPeriod(new Date('2026-03-15T12:00:00Z'));
    expect(periodToIsoDate(period)).toBe('2026-03-01');
  });

  it('pads the month to two digits', () => {
    const period = getMonthlyPeriod(new Date('2026-01-01T00:00:00Z'));
    expect(periodToIsoDate(period)).toBe('2026-01-01');
  });
});

describe('nextPeriod', () => {
  it('advances one month', () => {
    const march = getMonthlyPeriod(new Date('2026-03-15T12:00:00Z'));
    const april = nextPeriod(march);
    expect(april.month).toBe(4);
    expect(april.startAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls across year boundary', () => {
    const december = getMonthlyPeriod(new Date('2026-12-01T00:00:00Z'));
    const january = nextPeriod(december);
    expect(january.year).toBe(2027);
    expect(january.month).toBe(1);
  });
});
