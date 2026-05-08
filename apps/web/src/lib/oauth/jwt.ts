/**
 * OIDC `id_token` signer.
 *
 * HS256 via `client_secret` — this is the OIDC `client_secret_jwt`
 * family. The firm's own `client_secret` is the signing key, so
 * verification is symmetric: the firm uses the same secret it
 * already has on its backend to validate the token. No JWKS, no
 * out-of-band key rollover — rotating the client secret from the
 * dashboard transparently rotates the id_token signing key too.
 *
 * Public clients do NOT receive an id_token (no shared secret to
 * sign with). The token handler enforces this.
 *
 * The token shape mirrors the OIDC 1.0 core spec (§2 id_token):
 *   - `iss` — Crivacy issuer URL
 *   - `sub` — user id (Crivacy customer uuid)
 *   - `aud` — OAuth client_id
 *   - `exp` / `iat` — standard epoch seconds
 *   - `nonce` — echoed from the authorize request when present
 *   - Crivacy KYC claims — emitted by `buildClaims`
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';
import type { JWTPayload } from 'jose';

import type { OauthClaimSet } from '@/lib/credentials/view';

const TEXT_ENCODER = new TextEncoder();

export interface IdTokenInput {
  readonly userId: string;
  readonly clientId: string;
  readonly nonce: string | null;
  readonly claims: OauthClaimSet;
  readonly issuer: string;
  readonly secret: string;
  /** TTL in seconds. Defaults to 1h to match access-token lifetime. */
  readonly ttlSeconds?: number;
}

export interface SignedIdToken {
  readonly token: string;
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export async function signIdToken(
  input: IdTokenInput,
  now: Date = new Date(),
): Promise<SignedIdToken> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + (input.ttlSeconds ?? 3600);
  const jti = randomUUID();

  const payload: JWTPayload & Record<string, unknown> = {
    ...input.claims,
  };
  if (input.nonce !== null && input.nonce.length > 0) {
    payload['nonce'] = input.nonce;
  }

  const key = TEXT_ENCODER.encode(input.secret);
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(input.userId)
    .setAudience(input.clientId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

  return {
    token,
    jti,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  };
}
