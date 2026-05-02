/**
 * JWT access tokens + refresh tokens for dashboard sessions.
 *
 * Access tokens use HS256 through the `jose` library. A symmetric MAC
 * is the right choice here because the same Node process both signs
 * and verifies — an asymmetric keypair would buy nothing but two extra
 * config values and some CPU. Claims carried in the token:
 *
 *     iss         AuthConfig.jwtIssuer
 *     aud         AuthConfig.jwtFirmAudience | AuthConfig.jwtAdminAudience
 *     sub         firmUserId | adminUserId
 *     iat         unix seconds (set by jose)
 *     exp         iat + AuthConfig.jwtAccessTtlSeconds
 *     jti         uuidv4, unique per token (persisted on the sessions row)
 *     kind        'firm' | 'admin'  — matches sessionKindEnum
 *     firm_id     firm UUID         — only on kind === 'firm'
 *     role        firm role / admin role
 *     scopes      string[]          — declared capabilities on this session
 *
 * Refresh tokens are NOT JWTs. They are 32-byte random values encoded
 * as base64url, and only their sha256 digest is stored (constant-time
 * compared on rotate). This gives rotation + revocation without the
 * complexity of refresh-token JWT introspection, and leaves the full
 * JWT surface for the short-lived access token only.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type JWTPayload,
  type JWTVerifyOptions,
  type JWTVerifyResult,
  SignJWT,
  errors as joseErrors,
  jwtVerify,
} from 'jose';

import type { ApiKeyScope } from '@crivacy/shared-types';

import type { AuthConfig } from './config';
import { AuthError } from './errors';

/* ---------- Types ---------- */

export type SessionKind = 'firm' | 'admin' | 'customer';
export type FirmUserRole = 'owner' | 'admin' | 'member' | 'viewer';
export type AdminUserRole = 'superadmin' | 'admin' | 'support';
export type CustomerRole = 'customer';

interface BaseClaims {
  readonly sub: string;
  readonly jti?: string;
  readonly scopes?: readonly ApiKeyScope[];
}

export interface FirmAccessClaims extends BaseClaims {
  readonly kind: 'firm';
  readonly firmId: string;
  readonly role: FirmUserRole;
}

export interface AdminAccessClaims extends BaseClaims {
  readonly kind: 'admin';
  readonly role: AdminUserRole;
}

export interface CustomerAccessClaims extends BaseClaims {
  readonly kind: 'customer';
  readonly role: CustomerRole;
}

export type AccessClaims = FirmAccessClaims | AdminAccessClaims | CustomerAccessClaims;

export interface SignedAccessToken {
  readonly token: string;
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface VerifiedAccessToken {
  readonly sub: string;
  readonly jti: string;
  readonly kind: SessionKind;
  readonly firmId: string | null;
  readonly role: FirmUserRole | AdminUserRole | CustomerRole;
  readonly scopes: readonly ApiKeyScope[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type JwtConfig = Pick<
  AuthConfig,
  'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
>;

export interface GeneratedRefreshToken {
  readonly token: string;
  readonly tokenHash: string;
}

/* ---------- Internals ---------- */

const REFRESH_TOKEN_BYTES = 32;

function secretKey(config: Pick<JwtConfig, 'jwtSecret'>): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

function audienceFor(kind: SessionKind, config: JwtConfig): string {
  if (kind === 'firm') return config.jwtFirmAudience;
  if (kind === 'admin') return config.jwtAdminAudience;
  return config.jwtCustomerAudience;
}

function allowedAudiences(config: JwtConfig): readonly string[] {
  return [config.jwtFirmAudience, config.jwtAdminAudience, config.jwtCustomerAudience];
}

/* ---------- Signing ---------- */

/**
 * Produce a signed access token. The `jti` is generated here and
 * returned alongside the string so the caller can persist it in
 * `sessions.jwt_jti` in the same DB transaction that also stores the
 * refresh token hash.
 *
 * `now` is a test hook — production callers always omit it.
 */
export async function signAccessToken(
  claims: AccessClaims,
  config: JwtConfig,
  now: Date = new Date(),
): Promise<SignedAccessToken> {
  const jti = claims.jti ?? randomUUID();
  const audience = audienceFor(claims.kind, config);
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + config.jwtAccessTtlSeconds;

  const payload: JWTPayload & Record<string, unknown> = {
    kind: claims.kind,
    role: claims.role,
    scopes: Array.from(claims.scopes ?? []),
  };
  if (claims.kind === 'firm') {
    payload['firm_id'] = claims.firmId;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(config.jwtIssuer)
    .setAudience(audience)
    .setSubject(claims.sub)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(config));

  return {
    token,
    jti,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  };
}

/* ---------- Verification ---------- */

/**
 * Allowed JWT algorithms — every crivacy JWT is HS256 (access tokens,
 * OAuth state, Google completion token, wallet challenge, email-change
 * token, OIDC id_token `client_secret_jwt` family). Passed to every
 * `jwtVerify` call so a token header advertising a different algorithm
 * (including `alg: none`, which jose rejects by default anyway, or a
 * future asymmetric alg added to the codebase by mistake) is refused
 * at the boundary. Keeps the algorithm contract in one place so schema
 * drift between sign site and verify site cannot happen silently.
 */
export const JWT_ALGORITHMS: readonly ['HS256'] = ['HS256'];

/**
 * `jwtVerify` wrapper that always enforces {@link JWT_ALGORITHMS}.
 *
 * Motivation: `jose.jwtVerify` honours whatever algorithm the token
 * header claims unless `algorithms` is passed. Omitting it is a
 * defense-in-depth miss — today every crivacy JWT is HS256 so there
 * is no exploitable confusion, but a future refactor that adds an
 * asymmetric algorithm (e.g. id_token RS256 for a JWKS-based OIDC
 * variant) would open the classic "asymmetric public key used as
 * HMAC secret" vector on any call site that forgot to update its
 * options. This helper makes the safe path the default: every
 * verification goes through it, additional constraints (issuer,
 * audience, currentDate) layer on top.
 *
 * Callers should prefer this helper over a bare `jwtVerify` import.
 * Lint-style reviewers can grep for `jwtVerify(` outside this module
 * as a red flag.
 */
export async function safeJwtVerify<T = JWTPayload>(
  token: string,
  secret: Uint8Array | string,
  opts: JWTVerifyOptions = {},
): Promise<JWTVerifyResult<T>> {
  const secretBytes =
    typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  const merged: JWTVerifyOptions = { ...opts, algorithms: [...JWT_ALGORITHMS] };
  return (await jwtVerify(token, secretBytes, merged)) as JWTVerifyResult<T>;
}

/**
 * Validate a JWT compact string. Maps jose's error hierarchy onto our
 * `AuthError` taxonomy so route code only has to catch one exception
 * type.
 *
 * `now` is a test hook for simulating the clock.
 */
export async function verifyAccessToken(
  token: string,
  config: JwtConfig,
  now: Date = new Date(),
): Promise<VerifiedAccessToken> {
  let result: JWTVerifyResult<JWTPayload>;
  try {
    // AUD-X-CRYPTO-001 fix: route through safeJwtVerify so the
    // HS256 whitelist is enforced here too, aligning with every
    // other JWT verify site in the codebase.
    result = await safeJwtVerify(token, secretKey(config), {
      issuer: config.jwtIssuer,
      audience: allowedAudiences(config) as string[],
      currentDate: now,
    });
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AuthError('expired_jwt', 'access token is expired', { cause: err });
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const code =
        err.claim === 'aud'
          ? 'invalid_jwt_audience'
          : err.claim === 'iss'
            ? 'invalid_jwt_issuer'
            : 'invalid_jwt';
      throw new AuthError(code, `jwt claim validation failed: ${err.claim}`, { cause: err });
    }
    if (
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWSInvalid
    ) {
      throw new AuthError('invalid_jwt', 'access token signature invalid', { cause: err });
    }
    if (err instanceof joseErrors.JOSEError) {
      throw new AuthError('malformed_jwt', 'access token could not be parsed', { cause: err });
    }
    throw err;
  }

  const payload = result.payload;
  const kind = payload['kind'];
  if (kind !== 'firm' && kind !== 'admin' && kind !== 'customer') {
    throw new AuthError('jwt_missing_claim', 'kind claim missing or invalid');
  }
  const role = payload['role'];
  if (typeof role !== 'string') {
    throw new AuthError('jwt_missing_claim', 'role claim missing');
  }
  const sub = payload.sub;
  if (typeof sub !== 'string') {
    throw new AuthError('jwt_missing_claim', 'sub claim missing');
  }
  const jti = payload.jti;
  if (typeof jti !== 'string') {
    throw new AuthError('jwt_missing_claim', 'jti claim missing');
  }
  const rawScopes = payload['scopes'];
  const scopes: ApiKeyScope[] = [];
  if (Array.isArray(rawScopes)) {
    for (const value of rawScopes) {
      if (typeof value !== 'string') {
        throw new AuthError('jwt_missing_claim', 'scopes claim must be string[]');
      }
      scopes.push(value as ApiKeyScope);
    }
  }
  let firmId: string | null = null;
  if (kind === 'firm') {
    const raw = payload['firm_id'];
    if (typeof raw !== 'string') {
      throw new AuthError('jwt_missing_claim', 'firm_id claim missing on a firm token');
    }
    firmId = raw;
  }
  const iatSec = payload.iat;
  const expSec = payload.exp;
  if (typeof iatSec !== 'number' || typeof expSec !== 'number') {
    throw new AuthError('jwt_missing_claim', 'iat/exp claims missing');
  }
  return {
    sub,
    jti,
    kind,
    firmId,
    role: role as FirmUserRole | AdminUserRole | CustomerRole,
    scopes,
    issuedAt: new Date(iatSec * 1000),
    expiresAt: new Date(expSec * 1000),
  };
}

/* ---------- Refresh tokens ---------- */

/**
 * Produce an opaque refresh token + its sha256 digest. Only the
 * digest is stored on the `sessions` row; the raw token is returned
 * to the client in an httpOnly cookie.
 */
export function generateRefreshToken(): GeneratedRefreshToken {
  const raw = randomBytes(REFRESH_TOKEN_BYTES);
  const token = raw.toString('base64url');
  const tokenHash = sha256(token);
  return { token, tokenHash };
}

/** sha256 digest of an arbitrary string, hex-encoded. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time compare a presented refresh token against the stored
 * digest. Timing-equal false on any length mismatch.
 */
export function verifyRefreshToken(presentedToken: string, storedHash: string): boolean {
  if (typeof presentedToken !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  const computed = sha256(presentedToken);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
