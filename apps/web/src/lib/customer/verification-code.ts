/**
 * 6-digit verification code generator and helpers.
 *
 * Codes are generated via `crypto.randomInt` (uniform distribution),
 * zero-padded to 6 digits, and stored as SHA-256 hash in the same
 * `token_hash` column that previously held link-based tokens.
 *
 * @module
 */

import { randomInt, timingSafeEqual } from 'node:crypto';

import { sha256 } from '@/lib/auth/jwt';

/** Maximum number of wrong code attempts before the code is invalidated. */
export const MAX_CODE_ATTEMPTS = 5;

/** Verification code TTL in seconds (10 minutes). */
export const VERIFICATION_CODE_TTL_SECONDS = 600;

/** Password reset code TTL in seconds (10 minutes). */
export const RESET_CODE_TTL_SECONDS = 600;

/** Maximum codes per customer per 15-minute window (rate limit). */
export const MAX_CODES_PER_WINDOW = 3;

/** Rate limit window in milliseconds (15 minutes). */
export const CODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Generate a cryptographically random 6-digit code.
 *
 * Returns the raw code string (zero-padded) and its SHA-256 hash
 * for database storage.
 *
 * @example
 * const { code, codeHash } = generateVerificationCode();
 * // code:     "048291"
 * // codeHash: "a1b2c3..." (hex)
 */
export function generateVerificationCode(): {
  readonly code: string;
  readonly codeHash: string;
} {
  // randomInt(0, 1_000_000) produces 0..999999 uniformly
  const numeric = randomInt(0, 1_000_000);
  const code = String(numeric).padStart(6, '0');
  const codeHash = sha256(code);
  return { code, codeHash };
}

/**
 * Hash a user-submitted code for comparison against stored hash.
 *
 * Normalises the input: trims whitespace, strips any spaces/dashes
 * that a user might paste (e.g. "0 4 8 2 9 1" → "048291").
 */
export function hashSubmittedCode(rawInput: string): string {
  const cleaned = rawInput.replace(/[\s\-]/g, '').trim();
  return sha256(cleaned);
}

/**
 * Format a 6-digit code with spaces for email display.
 *
 * @example
 * formatCodeForEmail("048291") → "0 4 8 2 9 1"
 */
export function formatCodeForEmail(code: string): string {
  return code.split('').join(' ');
}

/**
 * Constant-time compare for two SHA-256 hex hashes.
 *
 * Both inputs are expected to be 64-char lowercase hex strings (the
 * shape this module emits). `!==` on hex strings is not exploitable
 * in our code-flow (SHA-256 avalanche destroys any gradient the
 * attacker could descend on), but the convention is cheap and keeps
 * future callers — where an attacker may control the hash directly —
 * safe by default.
 *
 * Returns `false` for any non-equal-length input instead of throwing,
 * so a caller that accidentally passes a malformed value gets a
 * "no match" result the same as an attacker would.
 */
export function constantTimeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
