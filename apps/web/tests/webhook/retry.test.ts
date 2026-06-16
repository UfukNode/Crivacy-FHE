/**
 * Tests for webhook retry schedule logic.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_DELAYS_SECONDS,
  WebhookError,
  computeNextRetryAt,
  formatRetryDelay,
  getRetryDelaySeconds,
  isMaxAttemptsReached,
} from '@/lib/webhook';

import { FIXTURE_NOW } from './fixtures';

describe('DEFAULT_RETRY_DELAYS_SECONDS', () => {
  it('has 7 entries matching PLAN.md §10', () => {
    expect(DEFAULT_RETRY_DELAYS_SECONDS).toEqual([10, 60, 300, 1800, 7200, 21600, 86400]);
    expect(DEFAULT_RETRY_DELAYS_SECONDS.length).toBe(7);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_RETRY_DELAYS_SECONDS)).toBe(true);
  });
});

describe('getRetryDelaySeconds', () => {
  it('returns correct delay for each attempt', () => {
    expect(getRetryDelaySeconds(0)).toBe(10); // 10s
    expect(getRetryDelaySeconds(1)).toBe(60); // 1m
    expect(getRetryDelaySeconds(2)).toBe(300); // 5m
    expect(getRetryDelaySeconds(3)).toBe(1800); // 30m
    expect(getRetryDelaySeconds(4)).toBe(7200); // 2h
    expect(getRetryDelaySeconds(5)).toBe(21600); // 6h
    expect(getRetryDelaySeconds(6)).toBe(86400); // 24h
  });

  it('clamps at last value for over-index', () => {
    expect(getRetryDelaySeconds(7)).toBe(86400);
    expect(getRetryDelaySeconds(100)).toBe(86400);
  });

  it('works with custom schedule', () => {
    expect(getRetryDelaySeconds(0, [5, 30])).toBe(5);
    expect(getRetryDelaySeconds(1, [5, 30])).toBe(30);
    expect(getRetryDelaySeconds(2, [5, 30])).toBe(30); // clamped
  });

  it('throws on empty schedule', () => {
    expect(() => getRetryDelaySeconds(0, [])).toThrow(WebhookError);
  });

  it('throws on negative attempt', () => {
    expect(() => getRetryDelaySeconds(-1)).toThrow(WebhookError);
  });

  it('throws on non-integer attempt', () => {
    expect(() => getRetryDelaySeconds(1.5)).toThrow(WebhookError);
  });
});

describe('computeNextRetryAt', () => {
  it('computes correct future timestamp', () => {
    const result = computeNextRetryAt(0, undefined, FIXTURE_NOW);
    expect(result.getTime()).toBe(FIXTURE_NOW.getTime() + 10 * 1000);
  });

  it('uses default schedule', () => {
    const result = computeNextRetryAt(3, undefined, FIXTURE_NOW);
    expect(result.getTime()).toBe(FIXTURE_NOW.getTime() + 1800 * 1000);
  });

  it('uses custom schedule', () => {
    const result = computeNextRetryAt(0, [5], FIXTURE_NOW);
    expect(result.getTime()).toBe(FIXTURE_NOW.getTime() + 5 * 1000);
  });
});

describe('isMaxAttemptsReached', () => {
  it('returns false when attempts < maxAttempts', () => {
    expect(isMaxAttemptsReached(3, 7)).toBe(false);
  });

  it('returns true when attempts = maxAttempts', () => {
    expect(isMaxAttemptsReached(7, 7)).toBe(true);
  });

  it('returns true when attempts > maxAttempts', () => {
    expect(isMaxAttemptsReached(8, 7)).toBe(true);
  });

  it('defaults maxAttempts to 7', () => {
    expect(isMaxAttemptsReached(6)).toBe(false);
    expect(isMaxAttemptsReached(7)).toBe(true);
  });
});

describe('formatRetryDelay', () => {
  it('formats seconds', () => {
    expect(formatRetryDelay(10)).toBe('10s');
    expect(formatRetryDelay(45)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatRetryDelay(60)).toBe('1m');
    expect(formatRetryDelay(300)).toBe('5m');
    expect(formatRetryDelay(1800)).toBe('30m');
  });

  it('formats hours', () => {
    expect(formatRetryDelay(3600)).toBe('1h');
    expect(formatRetryDelay(7200)).toBe('2h');
    expect(formatRetryDelay(86400)).toBe('24h');
  });
});
