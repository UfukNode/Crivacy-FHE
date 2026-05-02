/**
 * Session record builders.
 *
 * The dashboard flow turns a validated login into a `sessions` row.
 * This module is the seam between the stateless JWT/refresh-token
 * primitives and the Drizzle insert: callers pass user identity plus
 * the desired session kind and receive an object that can be dropped
 * straight into `db.insert(sessions).values(...)`, plus the raw
 * access / refresh strings to return to the browser.
 *
 * Nothing here touches the database; the split keeps this module
 * testable without a Postgres fixture, and lets repository code
 * compose multi-row transactions (insert session + update
 * `firm_users.last_login_at`) without losing visibility into which
 * values were generated for the row.
 */

import type { ApiKeyScope } from '@crivacy/shared-types';

import type { AuthConfig } from './config';
import { AuthError } from './errors';
import {
  type AccessClaims,
  type AdminUserRole,
  type FirmUserRole,
  type SessionKind,
  type SignedAccessToken,
  generateRefreshToken,
  signAccessToken,
} from './jwt';

/* ---------- Constants ---------- */

/**
 * `revoked_reason` value written when the refresh-token reuse-detection
 * branch fires (OWASP ASVS V3.5.5 token-family revoke). Single source of
 * truth — imported by the 3 audience refresh routes (customer / firm /
 * admin). 23 chars, well under the `varchar(64)` column cap.
 */
export const TOKEN_REUSE_REVOCATION_REASON = 'token_reuse_detected';

/* ---------- Types ---------- */

export type SessionJwtConfig = Pick<
  AuthConfig,
  | 'jwtSecret'
  | 'jwtIssuer'
  | 'jwtFirmAudience'
  | 'jwtAdminAudience'
  | 'jwtCustomerAudience'
  | 'jwtAccessTtlSeconds'
  | 'jwtRefreshTtlSeconds'
>;

interface BaseSessionInput {
  readonly userId: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface BuildFirmSessionInput extends BaseSessionInput {
  readonly kind: 'firm';
  readonly firmId: string;
  readonly role: FirmUserRole;
}

export interface BuildAdminSessionInput extends BaseSessionInput {
  readonly kind: 'admin';
  readonly role: AdminUserRole;
}

export type BuildSessionInput = BuildFirmSessionInput | BuildAdminSessionInput;

/**
 * Matches the Drizzle `NewSession` shape for the `sessions` table
 * exactly, minus the DB-defaults (`id`, `issuedAt`). A repository
 * uses it as the argument to `db.insert(sessions).values(...)`.
 */
export interface SessionInsertRecord {
  readonly userId: string;
  readonly userKind: SessionKind;
  readonly jwtJti: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenVersion: number;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface BuiltSession {
  /** Plain access token, return to the client in a cookie or body. */
  readonly accessToken: string;
  /** Plain refresh token, return to the client in an httpOnly cookie. */
  readonly refreshToken: string;
  /** Row ready to insert into `sessions`. */
  readonly record: SessionInsertRecord;
  /** Access-token expiry as a `Date`. */
  readonly accessExpiresAt: Date;
  /** Refresh-token expiry as a `Date`. */
  readonly refreshExpiresAt: Date;
  /** The JWT `jti` claim that was embedded in `accessToken`. */
  readonly jti: string;
}

export interface RotateSessionInput {
  readonly userId: string;
  readonly kind: SessionKind;
  readonly firmId?: string;
  readonly role: FirmUserRole | AdminUserRole;
  readonly scopes?: readonly ApiKeyScope[];
  readonly previousRefreshTokenVersion: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/* ---------- Build ---------- */

/**
 * Create a fresh session: sign the access token, roll a refresh
 * token, and assemble the row to insert. `now` is a test hook.
 */
export async function buildSession(
  input: BuildSessionInput,
  config: SessionJwtConfig,
  now: Date = new Date(),
): Promise<BuiltSession> {
  validateIdentity(input);
  const claims = toAccessClaims(input);
  const signed = await signAccessToken(claims, config, now);
  const refresh = generateRefreshToken();
  const refreshExpiresAt = new Date(now.getTime() + config.jwtRefreshTtlSeconds * 1000);
  return assemble({
    input,
    signed,
    refresh,
    refreshExpiresAt,
    refreshTokenVersion: 1,
  });
}

/* ---------- Rotate ---------- */

/**
 * Issue a new access+refresh pair for an existing session row. The
 * caller is responsible for loading the previous row, verifying the
 * presented refresh token against its hash, and bumping
 * `refresh_token_version` from the stored value.
 */
export async function rotateSession(
  input: RotateSessionInput,
  config: SessionJwtConfig,
  now: Date = new Date(),
): Promise<BuiltSession> {
  if (
    !Number.isInteger(input.previousRefreshTokenVersion) ||
    input.previousRefreshTokenVersion < 1
  ) {
    throw new AuthError('invalid_refresh_token', 'previousRefreshTokenVersion must be >= 1');
  }
  const claims: AccessClaims =
    input.kind === 'firm'
      ? {
          kind: 'firm',
          sub: input.userId,
          firmId: requireFirmId(input.firmId),
          role: input.role as FirmUserRole,
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        }
      : {
          kind: 'admin',
          sub: input.userId,
          role: input.role as AdminUserRole,
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        };
  const signed = await signAccessToken(claims, config, now);
  const refresh = generateRefreshToken();
  const refreshExpiresAt = new Date(now.getTime() + config.jwtRefreshTtlSeconds * 1000);
  return {
    accessToken: signed.token,
    refreshToken: refresh.token,
    accessExpiresAt: signed.expiresAt,
    refreshExpiresAt,
    jti: signed.jti,
    record: {
      userId: input.userId,
      userKind: input.kind,
      jwtJti: signed.jti,
      refreshTokenHash: refresh.tokenHash,
      refreshTokenVersion: input.previousRefreshTokenVersion + 1,
      expiresAt: signed.expiresAt,
      refreshExpiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  };
}

/* ---------- Helpers ---------- */

function assemble(args: {
  input: BuildSessionInput;
  signed: SignedAccessToken;
  refresh: { token: string; tokenHash: string };
  refreshExpiresAt: Date;
  refreshTokenVersion: number;
}): BuiltSession {
  const { input, signed, refresh, refreshExpiresAt, refreshTokenVersion } = args;
  return {
    accessToken: signed.token,
    refreshToken: refresh.token,
    accessExpiresAt: signed.expiresAt,
    refreshExpiresAt,
    jti: signed.jti,
    record: {
      userId: input.userId,
      userKind: input.kind,
      jwtJti: signed.jti,
      refreshTokenHash: refresh.tokenHash,
      refreshTokenVersion,
      expiresAt: signed.expiresAt,
      refreshExpiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  };
}

function validateIdentity(input: BuildSessionInput): void {
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new AuthError('jwt_missing_claim', 'userId is required');
  }
  if (input.kind === 'firm' && (typeof input.firmId !== 'string' || input.firmId.length === 0)) {
    throw new AuthError('jwt_missing_claim', 'firmId is required on a firm session');
  }
}

function toAccessClaims(input: BuildSessionInput): AccessClaims {
  if (input.kind === 'firm') {
    return {
      kind: 'firm',
      sub: input.userId,
      firmId: input.firmId,
      role: input.role,
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    };
  }
  return {
    kind: 'admin',
    sub: input.userId,
    role: input.role,
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
  };
}

function requireFirmId(firmId: string | undefined): string {
  if (typeof firmId !== 'string' || firmId.length === 0) {
    throw new AuthError('jwt_missing_claim', 'firmId is required on a firm rotation');
  }
  return firmId;
}
