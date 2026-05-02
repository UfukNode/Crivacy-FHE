/**
 * Shared single-use invite-token primitives.
 *
 * Both the admin-seeded firm owner flow and the dashboard team
 * invite flow use the same mechanism: raw 32-byte URL-safe random
 * token emailed to the recipient, SHA-256 hash stored in
 * `firm_user_invites`. Keeping the generator + hasher here prevents
 * two sites of truth from drifting (e.g. one upgrading to a stronger
 * hash while the other keeps the old one and silently fails to
 * match).
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * 32 bytes of CSPRNG entropy encoded as URL-safe base64 (no padding).
 * 43 characters on the wire, 256 bits of collision resistance.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest. Used for at-rest storage of invitation tokens
 * so a DB leak cannot be replayed — the raw token only ever lives in
 * the outbound email.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
