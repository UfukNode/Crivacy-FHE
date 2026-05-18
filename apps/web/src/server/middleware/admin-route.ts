/**
 * Admin route builder — for JWT session-authenticated admin endpoints.
 *
 * Pipeline (mirrors dashboardRoute but uses admin users):
 *
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Extract JWT from `Authorization: Bearer <token>` header
 *      or `__crivacy_at` cookie
 *   3. Verify JWT signature + claims → extract userId, role
 *   4. Verify `kind === 'admin'` (rejects firm sessions)
 *   5. Look up session row by `jti` → verify not revoked
 *   6. Look up admin user → verify not locked
 *   7. Check IP allowlist (if configured)
 *   8. Optionally check required role
 *   9. Build `AdminContext`
 *   10. Call handler
 *   11. On error → map via error-mapper → `ctx.errorJson()`
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
import { RbacError } from '@/lib/rbac/errors';
import type { PermissionCode } from '@/lib/rbac/permissions';
import { resolveEffectivePermissions } from '@/lib/rbac/resolve';
import { adminUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';

import {
  type AdminContext,
  type ResolvedAdminUser,
  buildAdminContext,
  buildRequestContext,
} from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';

// ---------------------------------------------------------------------------
// DI interfaces
// ---------------------------------------------------------------------------

/**
 * Look up a session row by its JWT `jti` claim.
 */
export interface AdminSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userKind: 'firm' | 'admin' | 'customer';
  readonly revokedAt: Date | null;
}

export type AdminSessionLookupFn = (
  db: CrivacyDatabase,
  jti: string,
) => Promise<AdminSessionRow | null>;

/**
 * Look up an admin user by ID.
 */
export interface AdminUserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'superadmin' | 'admin' | 'support';
  readonly ipAllowlist: readonly string[];
  readonly lockedAt: Date | null;
}

export type AdminUserLookupFn = (
  db: CrivacyDatabase,
  userId: string,
) => Promise<AdminUserRow | null>;

// ---------------------------------------------------------------------------
// Role type
// ---------------------------------------------------------------------------

export type AdminRole = 'superadmin' | 'admin' | 'support';

const ADMIN_ROLE_HIERARCHY: Record<AdminRole, number> = {
  support: 0,
  admin: 1,
  superadmin: 2,
};

/**
 * Check if the admin's role meets or exceeds the minimum required role.
 */
export function meetsAdminRoleRequirement(userRole: AdminRole, minRole: AdminRole): boolean {
  return ADMIN_ROLE_HIERARCHY[userRole] >= ADMIN_ROLE_HIERARCHY[minRole];
}

// ---------------------------------------------------------------------------
// IP allowlist (IPv4 + IPv6)
// ---------------------------------------------------------------------------

import { BlockList, isIP } from 'node:net';

/**
 * Check if the client IP matches the admin user's allowlist.
 * Empty allowlist = any IP allowed.
 *
 * Supports exact match + CIDR for BOTH IPv4 and IPv6 via Node's
 * built-in `net.BlockList`. Previously IPv4-only (AUD-ADM-AUTHZ-001)
 * which silently 403'd CF Warp, mobile-ISP, IPv6-only office clients.
 */
export function checkIpAllowlist(ip: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (ip === null) return false;

  const ipVersion = isIP(ip);
  if (ipVersion === 0) return false;

  const blockList = new BlockList();
  for (const entry of allowlist) {
    try {
      if (entry.includes('/')) {
        const [cidrIp, prefixStr] = entry.split('/');
        if (cidrIp === undefined || prefixStr === undefined) continue;
        const prefix = Number.parseInt(prefixStr, 10);
        if (Number.isNaN(prefix)) continue;
        const family = isIP(cidrIp);
        if (family === 0) continue;
        blockList.addSubnet(cidrIp, prefix, family === 4 ? 'ipv4' : 'ipv6');
      } else {
        const family = isIP(entry);
        if (family === 0) continue;
        blockList.addAddress(entry, family === 4 ? 'ipv4' : 'ipv6');
      }
    } catch {
      // Malformed allowlist entry — skip silently. Admin's intent is
      // preserved for the well-formed rest of the list.
      continue;
    }
  }

  return blockList.check(ip, ipVersion === 4 ? 'ipv4' : 'ipv6');
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Next.js App Router dynamic route params vary per-route
export type AdminHandler = (ctx: AdminContext, extra: any) => Promise<NextResponse> | NextResponse;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Auth config provider — eager or lazy to avoid build-time env access. */
export type AdminAuthConfigProvider =
  | Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >
  | (() => Pick<
      AuthConfig,
      'jwtSecret' | 'jwtIssuer' | 'jwtFirmAudience' | 'jwtAdminAudience' | 'jwtCustomerAudience' | 'jwtAccessTtlSeconds'
    >);

export interface AdminRouteOptions {
  /**
   * Permission code that must appear in the caller's effective
   * permission set (mirrors `DashboardRouteOptions.permission`).
   * When provided, the middleware resolves the set and throws
   * `RbacError('permission_denied')` if absent. Typed against
   * `PermissionCode`.
   *
   * Routes that deliberately want no permission gate (self-service
   * `/me`, `/logout`, participant-accept/decline) omit this field.
   */
  readonly permission?: PermissionCode;
  /** Permission resolver — injectable for testing. */
  readonly permissionsResolver?: (
    db: CrivacyDatabase,
    userId: string,
    userType: 'firm_user' | 'admin_user',
  ) => Promise<Set<string>>;
  /** The handler to execute after auth. */
  readonly handler: AdminHandler;
  /** Auth config — accepts a getter to avoid build-time env access. */
  readonly authConfig?: AdminAuthConfigProvider;
  /** Session lookup. */
  readonly sessionLookup?: AdminSessionLookupFn;
  /** Admin user lookup. */
  readonly adminUserLookup?: AdminUserLookupFn;
  /** DB factory — injected for testing. */
  readonly dbFactory?: () => CrivacyDatabase;
  /** Clock — injected for testing. */
  readonly clock?: () => Date;
  /** Request ID factory — injected for testing. */
  readonly requestIdFactory?: () => string;
}

// ---------------------------------------------------------------------------
// Token extraction (shared with dashboard-route)
// ---------------------------------------------------------------------------

import { ADMIN_ACCESS_COOKIE } from '@/lib/auth/cookie-names';

const AUTH_HEADER_PREFIX = 'Bearer ';
const COOKIE_NAME = ADMIN_ACCESS_COOKIE;

/**
 * Extract the admin JWT from the request. Uses a different cookie name
 * than the firm dashboard to prevent session confusion.
 */
export function extractAdminToken(request: NextRequest): string | null {
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
 * admin endpoint.
 */
export function adminRoute(
  options: AdminRouteOptions,
  // biome-ignore lint/suspicious/noExplicitAny: Next.js dynamic route params
): (request: NextRequest, extra: any) => Promise<NextResponse> {
  const {
    permission,
    permissionsResolver = resolveEffectivePermissions,
    handler,
    authConfig,
    sessionLookup,
    adminUserLookup,
    dbFactory,
    clock,
    requestIdFactory,
  } = options;

  const getDb = dbFactory ?? (() => getDatabaseClient().db);

  // biome-ignore lint/suspicious/noExplicitAny: Next.js dynamic route params
  return async (request: NextRequest, extra?: any): Promise<NextResponse> => {
    const db = getDb();
    const baseCtx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      // --- 1. Extract JWT ---
      const token = extractAdminToken(request);
      if (token === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Admin authentication required.', 401);
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
        return baseCtx.errorJson('invalid_session', 'Invalid or expired admin session.', 401);
      }

      // --- 3. Only admin sessions allowed ---
      if (verified.kind !== 'admin') {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson(
          'invalid_session',
          'This endpoint requires an admin session.',
          401,
        );
      }

      // --- 4. Look up session ---
      if (sessionLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Session lookup not configured.', 500);
      }

      const session = await sessionLookup(db, verified.jti);
      if (session === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Admin session not found.', 401);
      }
      if (session.revokedAt !== null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Admin session has been revoked.', 401);
      }

      // --- 5. Look up admin user ---
      if (adminUserLookup === undefined) {
        return baseCtx.errorJson('internal_error', 'Admin user lookup not configured.', 500);
      }

      const adminUser = await adminUserLookup(db, verified.sub);
      if (adminUser === null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Admin user not found.', 401);
      }
      if (adminUser.lockedAt !== null) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('invalid_session', 'Admin account is locked.', 401);
      }

      // --- 6. IP allowlist ---
      if (!checkIpAllowlist(baseCtx.ip, adminUser.ipAllowlist)) {
        recordAuthAttempt('jwt', 'failure');
        return baseCtx.errorJson('ip_not_allowed', 'Request from unauthorized IP address.', 403);
      }

      // --- 7. Resolve effective permissions (single DB join; DI'd for tests) ---
      const permissions = await permissionsResolver(db, adminUser.id, 'admin_user');

      // --- 8. Permission check ---
      //
      // Same denial-audit pattern as dashboardRoute: write the
      // security event first, swallow any audit-layer failure, then
      // throw the RbacError that maps to 403.
      if (permission !== undefined && !permissions.has(permission)) {
        try {
          await writeAudit(db, {
            action: 'access.permission_denied',
            actor: adminUserActor({
              id: adminUser.id,
              label: adminUser.email,
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
          // Audit failure is observability-only; never block the 403.
        }
        throw new RbacError(
          'permission_denied',
          `This action requires the '${permission}' permission.`,
        );
      }

      // --- 9. Build context ---
      const user: ResolvedAdminUser = {
        id: adminUser.id,
        email: adminUser.email,
        displayName: adminUser.displayName,
        role: adminUser.role,
      };

      const ctx = buildAdminContext(
        baseCtx,
        user,
        {
          sessionId: session.id,
          jti: verified.jti,
          kind: 'admin',
        },
        permissions,
      );

      recordAuthAttempt('jwt', 'success');

      // --- 10. Call handler ---
      return await handler(ctx, extra);
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
