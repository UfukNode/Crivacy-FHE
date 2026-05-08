/**
 * OAuth access-token primitives.
 *
 * Opaque tokens: 32 bytes of entropy encoded base64url. Hashed
 * (SHA-256) before DB storage, identical pattern to authorization
 * codes and invite tokens. The firm presents the raw token at
 * `/oauth/userinfo`; we re-hash and look up.
 *
 * Chose opaque over JWT so consent revoke is instant. A JWT would
 * stay valid until `exp` unless we maintained a denylist — which is
 * effectively the `revoked_at` column on this table. Opaque wins
 * the round-trip cost trade (single indexed lookup per userinfo
 * call) and keeps the code path small.
 *
 * Refresh tokens follow in a later phase (same shape, longer TTL,
 * rotates on exchange).
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';

/** Access token TTL (seconds). 1 hour matches the OAuth 2.1 default. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAccessToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
