/**
 * Dashboard route builder — for JWT session-authenticated endpoints.
 *
 * Pipeline (mirrors apiRoute but uses JWT instead of API key):
 *
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Extract JWT from `Authorization: Bearer <token>` header
 *      or `__crivacy_at` cookie
 *   3. Verify JWT signature + claims → extract userId, firmId, role
 *   4. Look up session row by `jti` → verify not revoked
 *   5. Look up firm user → verify not locked
 *   6. Look up firm → verify not deleted
 *   7. Optionally check required role
 *   8. Build `DashboardContext`
 *   9. Call handler
 *   10. On error → map via error-mapper → `ctx.errorJson()`
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import type { NextRequest, NextResponse } from 'next/server';

import type { AuthConfig } from '@/lib/auth/config';
import type { VerifiedAccessToken } from '@/lib/auth/jwt';
import { verifyAccessToken } from '@/lib/auth/jwt';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getDatabaseClient } from '@/lib/db/client';
import { recordAuthAttempt } from '@/lib/observability/request-metrics';
import { RbacError } from '@/lib/rbac/errors';
import type { PermissionCode } from '@/lib/rbac/permissions';
import { resolveEffectivePermissions } from '@/lib/rbac/resolve';
import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';

import {
  type DashboardContext,
  type ResolvedDashboardUser,
  type ResolvedFirm,
  buildDashboardContext,
  buildRequestContext,
} from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';

// ---------------------------------------------------------------------------
// DI interfaces
// ---------------------------------------------------------------------------

/**
 * Look up a session row by its JWT `jti` claim. Returns null if the
 * session does not exist or is revoked.
 */
export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userKind: 'firm' | 'admin' | 'customer';
  readonly revokedAt: Date | null;
}

export type SessionLookupFn = (db: CrivacyDatabase, jti: string) => Promise<SessionRow | null>;

/**
 * Look up a firm user by ID. Returns null if not found.
 */
export interface FirmUserRow {
  readonly id: string;
  readonly firmId: string;
  readonly email: string;
  readonly role: 'owner' | 'admin' | 'member' | 'viewer';
  readonly lockedAt: Date | null;
}

export type FirmUserLookupFn = (db: CrivacyDatabase, userId: string) => Promise<FirmUserRow | null>;

/**
 * Look up a firm by ID.
 */
export type FirmLookupFn = (db: CrivacyDatabase, firmId: string) => Promise<ResolvedFirm | null>;

// ---------------------------------------------------------------------------
// Role type
// ---------------------------------------------------------------------------

export type DashboardRole = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_HIERARCHY: Record<DashboardRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Check if the user's role meets or exceeds the minimum required role.
 */
export function meetsRoleRequirement(userRole: DashboardRole, minRole: DashboardRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole];
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type DashboardHandler = (ctx: DashboardContext) => Promise<NextResponse> | NextResponse;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Auth config can be provided eagerly or as a lazy getter (avoids build-time env access). */
export type AuthConfigProvider =
  | Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >
  | (() => Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >);

export interface DashboardRouteOptions {
  /**
   * Permission code that must appear in the caller's effective
   * permission set. When provided, the middleware resolves the
   * set via `resolveEffectivePermissions` and throws
   * `RbacError('permission_denied')` if the code is absent.
   *
   * Typed against `PermissionCode` so typos become compile errors.
   *
   * Routes that deliberately want no permission gate (self-service
   * `/me`, `/logout`) simply omit this field — session authentication
   * alone is the security boundary there.
   */
  readonly permission?: PermissionCode;
  /**
   * Factory for the NOBYPASSRLS handler pool — injected for testing.
   * Production: `() => getDatabaseClient().app`. Tests supply their
   * own mock database (often the same one they hand to `dbFactory`)
   * so the transaction wrapper exercises a working drizzle handle.
   * When omitted, falls back to the `app` pool of the live client.
   *
   * The middleware wraps `handler(ctx)` in
   * `appDbFactory().transaction(async tx => { SET LOCAL app.firm_id;
   * handler(tx); })` so every handler query runs inside a per-
   * request scope that RLS policies (phases 7+) can gate. Until
   * policies ship, `.app` is aliased onto `.admin` in the live
   * client (see `lib/db/client.ts`), so behaviour is identical to
   * the pre-refactor path.
   */
  readonly appDbFactory?: () => CrivacyDatabase;
  /**
   * Permission resolver — injectable for testing. Production always
   * uses the real `resolveEffectivePermissions` against the live DB;
   * tests inject a stub that returns a fixture set without a Drizzle
   * select chain the mock DB cannot satisfy.
   *
   * When omitted, the middleware falls back to the live resolver.
   */
  readonly permissionsResolver?: (
    db: CrivacyDatabase,
    userId: string,
    userType: 'firm_user' | 'admin_user',
  ) => Promise<Set<string>>;
  /** The handler to execute after auth. */
  readonly handler: DashboardHandler;
  /** Auth config — injected for testing. Accepts a getter to avoid build-time env access. */
  readonly authConfig?: AuthConfigProvider;
  /** Session lookup — injected for testing. */
  readonly sessionLookup?: SessionLookupFn;
  /** Firm user lookup — injected for testing. */
  readonly firmUserLookup?: FirmUserLookupFn;
  /** Firm lookup — injected for testing. */
  readonly firmLookup?: FirmLookupFn;
  /** DB factory — injected for testing. */
  readonly dbFactory?: () => CrivacyDatabase;
  /** Clock — injected for testing. */
  readonly clock?: () => Date;
  /** Request ID factory — injected for testing. */
  readonly requestIdFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

import { DASHBOARD_ACCESS_COOKIE } from '@/lib/auth/cookie-names';

const AUTH_HEADER_PREFIX = 'Bearer ';
const COOKIE_NAME = DASHBOARD_ACCESS_COOKIE;

/**
 * Extract the JWT from the request. Prefers the Authorization header
 * over the cookie.
 */
export function extractToken(request: NextRequest): string | null {
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
 * dashboard endpoint.
 */
export function dashboardRoute(
  options: DashboardRouteOptions,
): (request: NextRequest) => Promise<NextResponse> {
  const {
    permission,
    permissionsResolver = resolveEffectivePermissions,
    handler,
    authConfig,
    sessionLookup,
    firmUserLookup,
    firmLookup,
    dbFactory,
    appDbFactory,
    clock,
    requestIdFactory,
  } = options;

  const getDb = dbFactory ?? (() => getDatabaseClient().db);
  // Default to `dbFactory` so test harnesses that only inject one
  // mock DB don't need to configure both — the RLS-specific pool
  // separation only matters in production where policies are
  // enabled. Production omits both factories and the live
  // `getDatabaseClient()` returns real split pools.
  const getAppDb =
    appDbFactory ??
    (dbFactory === undefined ? (): CrivacyDatabase => getDatabaseClient().app : dbFactory);

  return async (request: NextRequest): Promise<NextResponse> => {
    const db = getDb();
    const now = clock?.() ?? new Date();
    const baseCtx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      // --- 1. Extract JWT ---
      const token = extractToken(request);
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
        verified = await verifyAccessToken(token, resolvedAuthConfig, now);
      } catch {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Invalid or expired session.', 401);
      }

      // Only firm sessions are allowed on dashboard routes
      if (verified.kind !== 'firm') {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'This endpoint requires a firm session.', 401);
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

      // --- 4. Look up firm user ---
      if (firmUserLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Firm user lookup not configured.', 500);
      }

      const firmUser = await firmUserLookup(db, verified.sub);
      if (firmUser === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'User not found.', 401);
      }
      if (firmUser.lockedAt !== null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Account is locked.', 401);
      }

      // --- 5. Look up firm ---
      if (firmLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Firm lookup not configured.', 500);
      }

      const firm = await firmLookup(db, firmUser.firmId);
      if (firm === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Firm not found.', 401);
      }
      if (firm.deletedAt !== null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Firm has been deactivated.', 401);
      }

      // --- 6. Resolve effective permissions ---
      //
      // One DB join per request. The result is passed into the
      // context so handler-level guards (target-type checks like
      // "Admin cannot change Owner role") reuse it without a second
      // query. Resolver is DI'd so unit tests can swap in a stub.
      const permissions = await permissionsResolver(db, firmUser.id, 'firm_user');

      // --- 7. Permission check ---
      //
      // Thrown as an RbacError so the error mapper produces the
      // correct `permission_denied` / 403 envelope without the
      // handler needing to know about the mapping. We also write a
      // security-relevant audit entry BEFORE throwing so the denial
      // appears in the trail even if the request is anonymous to
      // subsequent log collectors. Audit write is wrapped in
      // try/catch — if the audit layer is down, we still want to
      // return 403 (never silently pass the request).
      if (permission !== undefined && !permissions.has(permission)) {
        try {
          await writeAudit(db, {
            action: 'access.permission_denied',
            actor: firmUserActor({
              id: firmUser.id,
              firmId: firmUser.firmId,
              label: firmUser.email,
            }),
            target: noTarget(),
            context: buildAuditRequestContext({
              ip: baseCtx.ip,
              userAgent: baseCtx.userAgent,
              requestId: baseCtx.requestId,
            }),
            meta: {
              permission,
              path: new URL(request.url).pathname,
              method: request.method,
            },
            ts: baseCtx.now,
          });
        } catch {
          // Swallow — the 403 below is more important than the
          // audit entry. A separate observability alert on audit
          // write failures would catch systemic problems.
        }
        throw new RbacError(
          'permission_denied',
          `This action requires the '${permission}' permission.`,
        );
      }

      // --- 8. Build context ---
      const user: ResolvedDashboardUser = {
        id: firmUser.id,
        firmId: firmUser.firmId,
        email: firmUser.email,
        role: firmUser.role,
      };

      recordAuthAttempt('jwt', 'success');

      // --- 9. RLS-scoped transaction + handler ---
      //
      // Every firm-facing handler call runs inside a per-request
      // transaction on the NOBYPASSRLS `crivacy_app` pool. The first
      // statement sets `app.firm_id`, which the Row-Level Security
      // policies added in phases 7-15 of the RLS refactor read via
      // `current_setting('app.firm_id')` to filter every row to the
      // calling firm. Pre-auth lookups above (session / firm_user /
      // firm / permissions) keep using the admin pool via `baseCtx.db`
      // because they need to see rows before we know which firm the
      // caller belongs to. Only the handler surface is RLS-scoped.
      //
      // Until a table has `ENABLE ROW LEVEL SECURITY`, the policy
      // reads no-op and behaviour is identical to the pre-refactor
      // path. Phase 2 (this) lands the transaction wrapper; phases
      // 7-15 opt tables into RLS one at a time without further
      // middleware churn.
      //
      // `SET LOCAL` scopes the setting to this transaction; commit /
      // rollback clears it automatically so the pooled connection
      // does not leak the firm context to the next caller.
      const appDb = getAppDb();
      return await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.firm_id', ${firmUser.firmId}, true)`);

        const ctx = buildDashboardContext(
          { ...baseCtx, db: tx as CrivacyDatabase },
          user,
          firm,
          {
            sessionId: session.id,
            jti: verified.jti,
            kind: 'firm',
          },
          permissions,
        );

        return await handler(ctx);
      });
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
