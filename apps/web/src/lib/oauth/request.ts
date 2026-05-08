/**
 * Authorization-request id primitives.
 *
 * Unlike codes and tokens, authorization-request ids are stored in
 * the clear (DB primary key) because they carry no capability on
 * their own — they are a resume ticket. A leaked request_id lets
 * an attacker peek at "this user is in flow for Firm X" but they
 * still can't fabricate a consent or a code. The IP/UA check in the
 * consent handler provides the final brake.
 *
 * 32 bytes of base64url keeps collision resistance high.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

export const AUTHORIZATION_REQUEST_TTL_SECONDS = 15 * 60;

export function generateAuthorizationRequestId(): string {
  return randomBytes(32).toString('base64url');
}
