/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) primitives.
 *
 * When a public client (SPA / mobile) initiates OAuth:
 *   1. Client generates a random `code_verifier`.
 *   2. Client sends `code_challenge = SHA256(code_verifier)` (base64url)
 *      + `code_challenge_method=S256` to `/authorize`.
 *   3. Later, client exchanges the code for a token and proves
 *      possession by sending the raw `code_verifier`.
 *   4. Server re-computes SHA-256(verifier) and checks it against
 *      the stored challenge.
 *
 * If an attacker intercepts the code in transit, they still can't
 * exchange it without the verifier (which never leaves the original
 * client). This module is the one place that validates PKCE
 * correctness — routing every exchange through `verifyCodeChallenge`
 * keeps the guarantee intact.
 *
 * We only accept `S256` — the `plain` method was deprecated by
 * OAuth 2.1 and is useless as a security control anyway.
 *
 * @module
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { OauthError } from './errors';

export type CodeChallengeMethod = 'S256';

/** RFC 7636 §4.1 — verifier is 43-128 chars of the unreserved URI set. */
const VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;
/** SHA-256 output base64url-encoded is always 43 chars (no padding). */
const CHALLENGE_REGEX = /^[A-Za-z0-9\-_]{43}$/;

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Compute the expected challenge for a verifier. Exported so tests
 * and the reference client can generate fixtures without duplicating
 * the hash logic.
 */
export function computeCodeChallenge(verifier: string, method: CodeChallengeMethod = 'S256'): string {
  if (method !== 'S256') {
    throw new OauthError('pkce_invalid', `Unsupported code_challenge_method: ${method}`);
  }
  const digest = createHash('sha256').update(verifier).digest();
  return base64urlEncode(digest);
}

/**
 * Validate the shape of an inbound `code_challenge` parameter.
 * Malformed challenges are rejected at the authorize endpoint so we
 * never store a value that can't possibly match a real verifier.
 */
export function assertValidCodeChallenge(
  challenge: string,
  method: string,
): asserts method is 'S256' {
  if (method !== 'S256') {
    throw new OauthError(
      'pkce_invalid',
      `code_challenge_method must be "S256" (got ${method}).`,
    );
  }
  if (!CHALLENGE_REGEX.test(challenge)) {
    throw new OauthError(
      'pkce_invalid',
      'code_challenge must be 43 characters of base64url (SHA-256 digest).',
    );
  }
}

/**
 * Validate the shape of an inbound `code_verifier` during token
 * exchange. Same principle as `assertValidCodeChallenge` — reject
 * malformed inputs before the cryptographic compare.
 */
export function assertValidCodeVerifier(verifier: string): void {
  if (!VERIFIER_REGEX.test(verifier)) {
    throw new OauthError(
      'pkce_invalid',
      'code_verifier must be 43-128 chars of [A-Z a-z 0-9 - . _ ~].',
    );
  }
}

/**
 * Compare the stored challenge to the digest of the supplied
 * verifier. `timingSafeEqual` rules out timing oracles even though
 * SHA-256 digests are public values — once tokens leak, attackers
 * have nothing to learn from timing, but the discipline means future
 * comparisons in this module can't accidentally become the wrong
 * kind.
 */
export function verifyCodeChallenge(
  storedChallenge: string,
  method: string,
  verifier: string,
): void {
  assertValidCodeVerifier(verifier);
  assertValidCodeChallenge(storedChallenge, method);
  const computed = computeCodeChallenge(verifier, method);
  const a = Buffer.from(storedChallenge, 'utf8');
  const b = Buffer.from(computed, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OauthError('pkce_invalid', 'PKCE verification failed: digest mismatch.');
  }
}
