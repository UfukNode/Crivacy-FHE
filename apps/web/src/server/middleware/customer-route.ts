/**
 * Customer route builder — for JWT session-authenticated customer endpoints.
 *
 * Pipeline (mirrors dashboardRoute but uses customer JWT):
 *
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Extract JWT from `Authorization: Bearer <token>` header
 *      or `__crivacy_ct` cookie
 *   3. Verify JWT signature + claims → extract customerId
 *   4. Look up customer_sessions row by `jti` → verify not revoked
 *   5. Look up customer → verify not locked/banned/deleted
 *   6. Build `CustomerContext`
 *   7. Call handler
 *   8. On error → map via error-mapper → `ctx.errorJson()`
 *
 * @module
 */

import type { NextRequest, NextResponse } from 'next/server';

import type { AuthConfig } from '@/lib/auth/config';
import type { VerifiedAccessToken } from '@/lib/auth/jwt';
import { verifyAccessToken } from '@/lib/auth/jwt';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getDatabaseClient } from '@/lib/db/client';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';

import {
  type CustomerContext,
  type ResolvedCustomer,
  buildCustomerContext,
  buildRequestContext,
} from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';

// ---------------------------------------------------------------------------
// DI interfaces
// ---------------------------------------------------------------------------

/**
 * Shape of a customer session row after lookup by JWT `jti` claim.
 * Returns null if the session does not exist.
 */
export interface CustomerSessionRow {
  readonly id: string;
  readonly customerId: string;
  readonly revokedAt: Date | null;
}

export type CustomerSessionLookupFn = (
  db: CrivacyDatabase,
  jti: string,
) => Promise<CustomerSessionRow | null>;

/**
 * Shape of a customer row after lookup by ID.
 * Returns null if the customer does not exist.
 */
export interface CustomerRow {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: 'pending_verification' | 'active' | 'suspended' | 'locked' | 'banned';
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly lockedAt: Date | null;
  readonly deletedAt: Date | null;
  /** Set when Didit revoked the user (Batch E). Null otherwise. */
  readonly revokedAt: Date | null;
  /** Per-customer consecutive Didit decline counter. */
  readonly consecutiveKycDeclines: number;
  /** UTC timestamp of the latest decline; paired with the counter. */
  readonly lastDeclineAt: Date | null;
}

export type CustomerLookupFn = (
  db: CrivacyDatabase,
  customerId: string,
) => Promise<CustomerRow | null>;

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type CustomerHandler = (ctx: CustomerContext) => Promise<NextResponse> | NextResponse;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Auth config can be provided eagerly or as a lazy getter (avoids build-time env access). */
export type CustomerAuthConfigProvider =
  | Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >
  | (() => Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >);

export interface CustomerRouteOptions {
  /** The handler to execute after auth. */
  readonly handler: CustomerHandler;
  /** Auth config — injected for testing. Accepts a getter to avoid build-time env access. */
  readonly authConfig?: CustomerAuthConfigProvider;
  /** Customer session lookup — injected for testing. */
  readonly sessionLookup?: CustomerSessionLookupFn;
  /** Customer lookup — injected for testing. */
  readonly customerLookup?: CustomerLookupFn;
  /** DB factory — injected for testing. */
  readonly dbFactory?: () => CrivacyDatabase;
  /** Clock — injected for testing. */
  readonly clock?: () => Date;
  /** Request ID factory — injected for testing. */
  readonly requestIdFactory?: () => string;
  /** If true, allows pending_verification customers (default: false). */
  readonly allowUnverified?: boolean;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

import { CUSTOMER_ACCESS_COOKIE } from '@/lib/auth/cookie-names';

const AUTH_HEADER_PREFIX = 'Bearer ';
const COOKIE_NAME = CUSTOMER_ACCESS_COOKIE;

/**
 * Extract the customer JWT from the request. Prefers the Authorization
 * header over the cookie.
 */
export function extractCustomerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith(AUTH_HEADER_PREFIX)) {
    const token = authHeader.slice(AUTH_HEADER_PREFIX.length).trim();
    if (token.length > 0) return token;
  }
  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieValue !== undefined && cookieValue.length > 0) {
    return cookieValue;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a Next.js App Router handler for a JWT-authenticated
 * customer endpoint.
 */
export function customerRoute(
  options: CustomerRouteOptions,
): (request: NextRequest) => Promise<NextResponse> {
  const {
    handler,
    authConfig,
    sessionLookup,
    customerLookup,
    dbFactory,
    clock,
    requestIdFactory,
    allowUnverified = false,
  } = options;

  const getDb = dbFactory ?? (() => getDatabaseClient().db);

  return async (request: NextRequest): Promise<NextResponse> => {
    const db = getDb();
    const baseCtx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      // --- 1. Extract JWT ---
      const token = extractCustomerToken(request);
      if (token === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Authentication required.', 401);
      }

      // --- 2. Verify JWT ---
      if (authConfig === undefined) {
        return baseCtx.errorJson('internal_error', 'Auth config not provided.', 500);
      }
      const resolvedAuthConfig = typeof authConfig === 'function' ? authConfig() : authConfig;

      let verified: VerifiedAccessToken;
      try {
        verified = await verifyAccessToken(token, resolvedAuthConfig, baseCtx.now);
      } catch {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Invalid or expired session.', 401);
      }

      // Only customer sessions are allowed on customer routes
      if (verified.kind !== 'customer') {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'This endpoint requires a customer session.', 401);
      }

      // --- 3. Look up session ---
      if (sessionLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Session lookup not configured.', 500);
      }

      const session = await sessionLookup(db, verified.jti);
      if (session === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Session not found.', 401);
      }
      if (session.revokedAt !== null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Session has been revoked.', 401);
      }

      // --- 4. Look up customer ---
      if (customerLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Customer lookup not configured.', 500);
      }

      const customer = await customerLookup(db, verified.sub);
      if (customer === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Account not found.', 401);
      }

      // --- 5. Check customer status ---
      if (customer.deletedAt !== null) {
        return baseCtx.errorJson('invalid_session', 'Account not found.', 401);
      }
      if (customer.status === 'banned') {
        return baseCtx.errorJson('account_banned', 'Account has been banned. Please contact support.', 403);
      }
      if (customer.status === 'locked') {
        return baseCtx.errorJson('account_locked', 'Account is temporarily locked.', 423);
      }
      if (customer.status === 'suspended') {
        // AUD-X-ERROR-001: distinct code for reversible suspend.
        return baseCtx.errorJson('account_suspended', 'Account is suspended. Contact support to review the restriction.', 403);
      }
      // Wallet-only users (no email) are always 'active', never 'pending_verification'.
      // But guard: if somehow pending_verification AND no email → treat as active.
      if (customer.status === 'pending_verification' && !allowUnverified) {
        if (customer.email !== null) {
          return baseCtx.errorJson('email_not_verified', 'Please verify your email first.', 403);
        }
        // Wallet-only user with no email — skip email verification gate
      }

      // --- 6. Build context ---
      const resolvedCustomer: ResolvedCustomer = {
        id: customer.id,
        email: customer.email,
        displayName: customer.displayName,
        status: customer.status,
        kycLevel: customer.kycLevel,
        kycScore: customer.kycScore,
        revokedAt: customer.revokedAt,
        consecutiveKycDeclines: customer.consecutiveKycDeclines,
        lastDeclineAt: customer.lastDeclineAt,
      };

      const ctx = buildCustomerContext(baseCtx, resolvedCustomer, {
        sessionId: session.id,
        jti: verified.jti,
        kind: 'customer',
      });

      recordAuthAttempt('jwt', 'success');

      // --- 7. Call handler ---
      return await handler(ctx);
    } catch (err) {
      if (err instanceof ParseError) {
        const status =
          err.code === 'payload_too_large'
            ? 413
            : err.code === 'unsupported_media_type'
              ? 415
              : 400;
        return baseCtx.errorJson(err.code, err.message, status);
      }
      const mapped = mapErrorToResponse(err);
      return baseCtx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
    }
  };
}
