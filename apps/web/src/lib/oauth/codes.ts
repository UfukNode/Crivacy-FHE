/**
 * OAuth authorization-code primitives.
 *
 * Raw codes are 32 bytes of CSPRNG entropy encoded as URL-safe
 * base64 (43 chars on the wire). Only the SHA-256 hash lives in the
 * DB — identical pattern to the invite-token and recovery-code
 * primitives so callers have one mental model for "single-use bearer
 * token with hash-at-rest".
 *
 * The raw code leaves Crivacy exactly once, in the redirect to the
 * firm's callback URL. Token exchange re-hashes the code and looks
 * up the row; a stolen code is useless to anyone who can't also
 * present a matching `code_verifier` and come from the originating
 * IP.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';

/** Code TTL in seconds. RFC 6749 §4.1.2 caps at 600; we use 60. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/**
 * Generate a fresh raw authorization code. 32 bytes → 43 base64url
 * chars. Not URL-escaped — base64url is already URL-safe.
 */
export function generateAuthorizationCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a code. Storage + lookup key. Hash output is
 * 64 hex chars; indexed as text because the column is the primary
 * key of `oauth_authorization_codes` for O(1) lookup.
 */
export function hashAuthorizationCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
