/**
 * Tests for webhook circuit breaker logic.
 */

import { describe, expect, it } from 'vitest';

import {
  computeCircuitBreakerUpdate,
  evaluateCircuitBreaker,
  isCircuitBreakerOpen,
} from '@/lib/webhook';

import { FIXTURE_NOW } from './fixtures';

describe('isCircuitBreakerOpen', () => {
  it('returns false when not tripped', () => {
    expect(isCircuitBreakerOpen({ consecutiveFailures: 0, circuitBreakerTrippedAt: null })).toBe(
      false,
    );
  });

  it('returns true when tripped', () => {
    expect(
      isCircuitBreakerOpen({ consecutiveFailures: 50, circuitBreakerTrippedAt: FIXTURE_NOW }),
    ).toBe(true);
  });
});

describe('evaluateCircuitBreaker', () => {
  it('returns none when below threshold', () => {
    expect(evaluateCircuitBreaker(49, 50)).toEqual({ action: 'none' });
  });

  it('returns trip when at threshold', () => {
    const result = evaluateCircuitBreaker(50, 50);
    expect(result.action).toBe('trip');
    if (result.action === 'trip') {
      expect(result.reason).toContain('50');
    }
  });

  it('returns trip when above threshold', () => {
    expect(evaluateCircuitBreaker(100, 50).action).toBe('trip');
  });

  it('uses default threshold of 50', () => {
    expect(evaluateCircuitBreaker(49).action).toBe('none');
    expect(evaluateCircuitBreaker(50).action).toBe('trip');
  });

  it('works with custom threshold', () => {
    expect(evaluateCircuitBreaker(9, 10).action).toBe('none');
    expect(evaluateCircuitBreaker(10, 10).action).toBe('trip');
  });
});

describe('computeCircuitBreakerUpdate', () => {
  const baseState = { consecutiveFailures: 0, circuitBreakerTrippedAt: null };

  it('resets failures on success', () => {
    const state = { consecutiveFailures: 10, circuitBreakerTrippedAt: null };
    const result = computeCircuitBreakerUpdate(state, true, 50, FIXTURE_NOW);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.circuitBreakerTrippedAt).toBeNull();
    expect(result.lastSuccessAt).toEqual(FIXTURE_NOW);
    expect(result.lastFailureAt).toBeUndefined();
    expect(result.tripped).toBe(false);
  });

  it('clears tripped state on success', () => {
    const state = { consecutiveFailures: 50, circuitBreakerTrippedAt: new Date('2026-01-01') };
    const result = computeCircuitBreakerUpdate(state, true, 50, FIXTURE_NOW);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.circuitBreakerTrippedAt).toBeNull();
  });

  it('increments failures on failure', () => {
    const result = computeCircuitBreakerUpdate(baseState, false, 50, FIXTURE_NOW);
    expect(result.consecutiveFailures).toBe(1);
    expect(result.circuitBreakerTrippedAt).toBeNull();
    expect(result.lastFailureAt).toEqual(FIXTURE_NOW);
    expect(result.lastSuccessAt).toBeUndefined();
    expect(result.tripped).toBe(false);
  });

  it('trips circuit breaker at threshold', () => {
    const state = { consecutiveFailures: 49, circuitBreakerTrippedAt: null };
    const result = computeCircuitBreakerUpdate(state, false, 50, FIXTURE_NOW);
    expect(result.consecutiveFailures).toBe(50);
    expect(result.circuitBreakerTrippedAt).toEqual(FIXTURE_NOW);
    expect(result.tripped).toBe(true);
  });

  it('keeps incrementing after trip', () => {
    const state = { consecutiveFailures: 50, circuitBreakerTrippedAt: FIXTURE_NOW };
    const later = new Date(FIXTURE_NOW.getTime() + 60000);
    const result = computeCircuitBreakerUpdate(state, false, 50, later);
    expect(result.consecutiveFailures).toBe(51);
    // Keep existing tripped time
    expect(result.circuitBreakerTrippedAt).toEqual(FIXTURE_NOW);
    expect(result.tripped).toBe(true);
  });

  it('uses default threshold of 50', () => {
    const state = { consecutiveFailures: 49, circuitBreakerTrippedAt: null };
    const result = computeCircuitBreakerUpdate(state, false);
    expect(result.tripped).toBe(true);
  });

  it('works with custom threshold', () => {
    const state = { consecutiveFailures: 4, circuitBreakerTrippedAt: null };
    const result = computeCircuitBreakerUpdate(state, false, 5, FIXTURE_NOW);
    expect(result.tripped).toBe(true);
    expect(result.consecutiveFailures).toBe(5);
  });
});
