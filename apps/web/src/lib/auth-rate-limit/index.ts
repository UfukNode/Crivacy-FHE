/**
 * Public barrel for the per-IP auth rate limiter.
 */

import { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';

import { enforceAuthRateLimit, type AuthRateLimitEndpoint } from './enforce';

export {
  enforceAuthRateLimit,
  type AuthRateLimitDecision,
  type AuthRateLimitEndpoint,
  type AuthRateLimitPolicy,
} from './enforce';

/**
 * Default `Retry-After` cooldown surfaced on `code_max_attempts` /
 * `code_rate_limited` 429 responses. The actual recovery path is
 * "request a new code via the resend endpoint", which has its own
 * sliding-window rate limit; this short value tells well-behaved
 * clients to pause briefly before retrying instead of hammering a
 * locked code row. RFC 6585 §4 mandates the header — this is the
 * single source of truth so all six verify routes agree.
 */
export const MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS = 60;

/**
 * Route-level shortcut: runs `enforceAuthRateLimit` and, when the
 * caller is over the cap, returns a ready-to-ship 429 response with
 * the standard `Retry-After` header. Returns `null` on allowed so
 * the caller can one-line the gate:
 *
 * ```ts
 * const limited = await maybeRateLimitResponse(db, 'customer_login', ctx.ip);
 * if (limited) return limited;
 * ```
 */
export async function maybeRateLimitResponse(
  db: CrivacyDatabase,
  endpoint: AuthRateLimitEndpoint,
  ip: string | null,
  now: Date = new Date(),
): Promise<NextResponse | null> {
  const decision = await enforceAuthRateLimit(db, endpoint, ip, now);
  if (decision.allowed) return null;
  return new NextResponse(
    JSON.stringify({
      error: {
        code: 'rate_limited',
        message: `Too many attempts. Retry in ${decision.retryAfterSeconds} seconds.`,
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(decision.retryAfterSeconds),
        'Cache-Control': 'no-store',
      },
    },
  );
}
