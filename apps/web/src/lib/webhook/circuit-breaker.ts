/**
 * Circuit breaker logic for webhook endpoints — pure functions.
 *
 * PLAN.md §10: "Circuit breaker: bir endpoint 50/saat fail ediyorsa
 * otomatik disable + alert."
 *
 * The circuit breaker state lives on the `webhook_endpoints` table
 * (`consecutive_failures`, `circuit_breaker_tripped_at`). This module
 * provides pure decision functions; the worker calls them and applies
 * the DB updates.
 *
 * @module
 */

/* ---------- Types ---------- */

export interface CircuitBreakerState {
  readonly consecutiveFailures: number;
  readonly circuitBreakerTrippedAt: Date | null;
}

export type CircuitBreakerAction =
  | { readonly action: 'trip'; readonly reason: string }
  | { readonly action: 'none' };

/* ---------- Pure functions ---------- */

/**
 * Check if a circuit breaker is currently open (tripped).
 */
export function isCircuitBreakerOpen(state: CircuitBreakerState): boolean {
  return state.circuitBreakerTrippedAt !== null;
}

/**
 * Decide whether to trip the circuit breaker after a failure.
 *
 * @param currentFailures - Consecutive failure count BEFORE this failure
 * @param threshold - Max failures before tripping (default 50)
 * @returns Action to take
 */
export function evaluateCircuitBreaker(
  currentFailures: number,
  threshold = 50,
): CircuitBreakerAction {
  // currentFailures is the count AFTER incrementing (caller increments first)
  if (currentFailures >= threshold) {
    return {
      action: 'trip',
      reason: `Circuit breaker tripped: ${currentFailures} consecutive failures (threshold: ${threshold}).`,
    };
  }
  return { action: 'none' };
}

/**
 * Compute the updated circuit breaker state after a delivery attempt.
 *
 * @param current - Current state from DB
 * @param success - Whether the delivery succeeded
 * @param threshold - Circuit breaker threshold
 * @param now - Current time
 * @returns Updated state fields to persist
 */
export function computeCircuitBreakerUpdate(
  current: CircuitBreakerState,
  success: boolean,
  threshold = 50,
  now: Date = new Date(),
): {
  readonly consecutiveFailures: number;
  readonly circuitBreakerTrippedAt: Date | null;
  readonly lastSuccessAt: Date | undefined;
  readonly lastFailureAt: Date | undefined;
  readonly tripped: boolean;
} {
  if (success) {
    return {
      consecutiveFailures: 0,
      circuitBreakerTrippedAt: null,
      lastSuccessAt: now,
      lastFailureAt: undefined,
      tripped: false,
    };
  }

  const newFailures = current.consecutiveFailures + 1;
  const decision = evaluateCircuitBreaker(newFailures, threshold);
  const tripped = decision.action === 'trip';

  return {
    consecutiveFailures: newFailures,
    circuitBreakerTrippedAt:
      tripped && current.circuitBreakerTrippedAt === null ? now : current.circuitBreakerTrippedAt,
    lastSuccessAt: undefined,
    lastFailureAt: now,
    tripped,
  };
}
