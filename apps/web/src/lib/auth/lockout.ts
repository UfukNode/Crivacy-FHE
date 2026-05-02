/**
 * Lockout duration — single source of truth for all 3 audiences.
 *
 * Pre-2026-04-27 the value was duplicated across 3 audiences with
 * 2 inconsistent values (customer 30, firm 15, admin 30) — drift
 * hazard with no security justification. F-A1-LOCK-DUR-001 closure
 * batch consolidated to a single 30-minute uniform value:
 *
 *   - Sector default (AWS Cognito, Okta, Stripe) = 30 minutes.
 *   - Firm 15 → 30 has no real UX cost: firm flow is TOTP-protected,
 *     so wrong-pwd lockout-trip is rare in practice + firm has team-
 *     admin unlock + forgot-password flow bypasses lockout entirely.
 *   - Aligns with CLAUDE.md "single source of truth" — one constant,
 *     one place to tighten or relax.
 *
 * Customer audience keeps an env override (`CUSTOMER_LOCK_DURATION_MINUTES`)
 * that DEFAULTS to this constant — operators who need a longer wait
 * for high-fraud markets can tune without code edits. Firm + admin
 * are not env-tunable (high-privilege paths benefit from a fixed,
 * audited value).
 *
 * @module
 */

/** Canonical lockout window in minutes. */
export const LOCKOUT_DURATION_MINUTES = 30;

/** Pre-multiplied milliseconds for `Date` math at call sites. */
export const LOCKOUT_DURATION_MS = LOCKOUT_DURATION_MINUTES * 60 * 1000;

// ---------------------------------------------------------------------------
// F-XCC-AE-PER-ACCOUNT-LOCKOUT-001 mitigation — 2 layer hardening
// ---------------------------------------------------------------------------

/**
 * Sliding-window decay TTL for the failed-login counter (Layer 1).
 *
 * Without this, a legitimate user's stale typos (e.g. 4 wrong attempts
 * spread across days) accumulate forever and the 5th wrong attempt
 * trips the lockout — so a user who occasionally fat-fingers their
 * password can lock themselves out after weeks of normal usage. With
 * the decay window, the counter resets to fresh on the first wrong
 * attempt that lands more than `FAILED_LOGIN_DECAY_MINUTES` after the
 * earliest attempt of the current run. An adversarial attacker still
 * needs only 5 wrong-pwds to lock the victim, but the attempts must
 * fall inside the 60-minute window — drive-by drip attacks fizzle out.
 */
export const FAILED_LOGIN_DECAY_MINUTES = 60;

/** Pre-multiplied seconds for the SQL `EXTRACT(EPOCH FROM …)` comparison. */
export const FAILED_LOGIN_DECAY_SECONDS = FAILED_LOGIN_DECAY_MINUTES * 60;

/**
 * Progressive delay (Layer 2) — tarpit on the wrong-password response.
 *
 * On the 3rd consecutive wrong-pwd we hold the response for 2s, on the
 * 4th 4s, on the 5th 8s. Cap at 8s so the handler never approaches the
 * Vercel edge runtime 10s timeout. Cumulative attacker cost over a 5-
 * shot lockout cycle ≈ 14s; for a 1000-account credential-stuffing run
 * that's 4 hours of serialised wait per attacker thread.
 *
 * Stripe pattern: the same delay applies on the `correct-password`
 * branch when the pre-state counter was already in the delay zone, so
 * a sprayer cannot use response-time alone to distinguish "the password
 * I just guessed was correct" from "the password I just guessed was
 * wrong". Without that mirror, the delay itself is a side-channel
 * oracle.
 */
export const PROGRESSIVE_DELAY_MAX_SECONDS = 8;

/** First counter value at which the tarpit fires. */
export const PROGRESSIVE_DELAY_THRESHOLD = 3;

/**
 * Compute the progressive-delay duration in milliseconds for an
 * attempt-count value.
 *
 *   attempts < threshold  → 0ms (no delay; fast path)
 *   attempts = 3          → 2_000ms
 *   attempts = 4          → 4_000ms
 *   attempts ≥ 5          → 8_000ms (capped at PROGRESSIVE_DELAY_MAX_SECONDS)
 */
export function getProgressiveDelayMs(attemptCount: number): number {
  if (attemptCount < PROGRESSIVE_DELAY_THRESHOLD) return 0;
  // 2^1 = 2s on attempt 3, 2^2 = 4s on attempt 4, 2^3 = 8s on attempt 5+
  const exp = Math.min(attemptCount - 2, 3);
  return Math.min(2 ** exp * 1000, PROGRESSIVE_DELAY_MAX_SECONDS * 1000);
}

/**
 * `await sleep(ms)` helper used by the progressive-delay sites. Inlined
 * here (instead of pulling in `node:timers/promises`) so the helper
 * runs unchanged on Edge runtime where `node:` builtins are not
 * available.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
