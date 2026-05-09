/**
 * Retry schedule math — pure functions for computing next retry timestamps.
 *
 * PLAN.md §10: retry policy [10s, 1m, 5m, 30m, 2h, 6h, 24h] — 7 attempts.
 *
 * @module
 */

import { WebhookError } from './errors';

/**
 * Default retry delays in seconds, matching PLAN.md §10.
 * Index 0 = delay after 1st failure, index 6 = delay after 7th failure.
 */
export const DEFAULT_RETRY_DELAYS_SECONDS = Object.freeze([
  10, 60, 300, 1800, 7200, 21600, 86400,
] as const);

/**
 * Get the retry delay for a given attempt number (0-indexed).
 *
 * If `attempt` exceeds the schedule length, returns the last value
 * (so callers can over-retry with a capped delay if needed).
 *
 * @param attempt - 0-indexed attempt number (0 = first retry after first failure)
 * @param schedule - Array of delay values in seconds
 * @returns Delay in seconds
 */
export function getRetryDelaySeconds(
  attempt: number,
  schedule: readonly number[] = DEFAULT_RETRY_DELAYS_SECONDS,
): number {
  if (schedule.length === 0) {
    throw new WebhookError(
      'invalid_retry_schedule',
      'Retry schedule must have at least one entry.',
    );
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new WebhookError(
      'invalid_retry_schedule',
      `Attempt must be a non-negative integer, got ${attempt}.`,
    );
  }

  const index = Math.min(attempt, schedule.length - 1);
  const delay = schedule[index];
  if (delay === undefined) {
    throw new WebhookError('invalid_retry_schedule', `Retry schedule missing index ${index}.`);
  }
  return delay;
}

/**
 * Compute the absolute timestamp for the next retry.
 *
 * @param attempt - 0-indexed: which retry this will be (0 = first retry)
 * @param schedule - Delay schedule in seconds
 * @param now - Current time
 * @returns Date of the next retry
 */
export function computeNextRetryAt(
  attempt: number,
  schedule: readonly number[] = DEFAULT_RETRY_DELAYS_SECONDS,
  now: Date = new Date(),
): Date {
  const delaySeconds = getRetryDelaySeconds(attempt, schedule);
  return new Date(now.getTime() + delaySeconds * 1000);
}

/**
 * Check if max attempts have been reached.
 *
 * @param attempts - Current number of completed attempts
 * @param maxAttempts - Maximum allowed attempts (default 7)
 * @returns true if no more retries should be scheduled
 */
export function isMaxAttemptsReached(attempts: number, maxAttempts = 7): boolean {
  return attempts >= maxAttempts;
}

/**
 * Describe a retry delay in human-readable form for logging.
 */
export function formatRetryDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
