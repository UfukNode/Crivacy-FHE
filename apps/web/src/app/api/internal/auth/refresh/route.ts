/**
 * POST /api/internal/auth/refresh, rotate dashboard refresh token
 *
 * Cookie-based refresh (same pattern as customer & admin refresh):
 *   1. Read `__crivacy_art` cookie
 *   2. Hash with SHA-256
 *   3. Find sessions row by refresh_token_hash WHERE user_kind = 'firm'
 *   4. Verify session not revoked / not expired
 *   5. Verify firm user not locked, firm not deleted
 *   6. Sign new access token, generate new refresh token
 *   7. Update session row
 *   8. Set new cookies
 *   9. Return 200
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { DASHBOARD_ACCESS_COOKIE, DASHBOARD_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { generateRefreshToken, sha256, signAccessToken } from '@/lib/auth/jwt';
import type { FirmUserRole, JwtConfig } from '@/lib/auth/jwt';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { writeAudit } from '@/lib/audit/writer';
import { firmUserActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { TOKEN_REUSE_REVOCATION_REASON } from '@/lib/auth/sessions';
import { emitSecurityEvent } from '@/lib/security-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_TOKEN_COOKIE = DASHBOARD_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = DASHBOARD_REFRESH_COOKIE;

/**
 * Build an error response that also clears dashboard auth cookies.
 *
 * When a refresh attempt fails (session revoked, user locked, firm
 * deleted, token expired, etc.), the browser still holds the httpOnly
 * auth cookies.  The Edge Middleware checks cookie PRESENCE to decide
 * whether the user is "logged in", if the cookies remain, it redirects
 * the user away from `/dashboard/login`, creating an infinite redirect
 * loop.
 *
 * Clearing cookies on every refresh error ensures the Edge Middleware
 * lets the user reach the login page.
 */
function refreshErrorResponse(
  ctx: ReturnType<typeof buildRequestContext>,
  code: string,
  message: string,
  status: number,
): NextResponse {
  const response = ctx.errorJson(code, message, status);
  const isProduction = process.env.NODE_ENV === 'production';

  response.cookies.set(ACCESS_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  response.cookies.set(REFRESH_TOKEN_COOKIE, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/internal/auth/refresh',
    maxAge: 0,
  });

  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const now = ctx.now;

    // --- 0. Per-IP rate limit ---
    //
    // Refresh is Turnstile-less (background + reactive-401 path). A
    // stolen `__crivacy_art` cookie without this cap could mint
    // unlimited access tokens. `firm_refresh` bucket: 20/60s —
    // meşru trafik (proactive 13dk + reactive 401) cap'e yaklaşmaz.
    const limited = await maybeRateLimitResponse(db, 'firm_refresh', ctx.ip, now);
    if (limited !== null) return limited;

    // --- 1. Extract refresh token from cookie ---
    const refreshCookie = request.cookies.get(DASHBOARD_REFRESH_COOKIE)?.value;
    if (refreshCookie === undefined || refreshCookie.length === 0) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Dashboard refresh token not found.', 401);
    }

    // --- 2. Hash and look up session ---
    //
    // Look up by current hash OR recently-rotated previous hash
    // (see customer refresh for the full race-loss rationale). The
    // `user_kind='firm'` predicate keeps this bucket isolated from
    // admin sessions on the same table.
    const tokenHash = sha256(refreshCookie);
    const RACE_GRACE_MS = 5_000;

    const sessionResult = await db.execute<{
      id: string;
      user_id: string;
      refresh_token_hash: string;
      refresh_token_version: number;
      refresh_expires_at: string;
      revoked_at: string | null;
      previous_refresh_token_hash: string | null;
      previous_rotation_at: string | null;
      expires_at: string;
      remember_me: boolean;
    }>(
      sql`SELECT id, user_id, refresh_token_hash, refresh_token_version::int,
           refresh_expires_at::text, revoked_at::text,
           previous_refresh_token_hash,
           previous_rotation_at::text,
           expires_at::text,
           remember_me
       FROM sessions
       WHERE (refresh_token_hash = ${tokenHash}
              OR previous_refresh_token_hash = ${tokenHash})
         AND user_kind = 'firm'
       LIMIT 1`,
    );
    const session = sessionResult.rows[0] as {
      id: string;
      user_id: string;
      refresh_token_hash: string;
      refresh_token_version: number;
      refresh_expires_at: string;
      revoked_at: string | null;
      previous_refresh_token_hash: string | null;
      previous_rotation_at: string | null;
      expires_at: string;
      remember_me: boolean;
    } | undefined;

    if (!session) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Invalid dashboard refresh token.', 401);
    }

    // --- 2a. Race-loss detection ---
    if (session.refresh_token_hash !== tokenHash) {
      // Auto-idempotency pin (F-XCC-AD-FAMILY-REVOKE-001 fix): a 2nd
      // post-grace replay against an already-revoked row exits here
      // before re-firing the audit + emit; the reuse-detection branch
      // below only runs once per family-compromise event.
      if (session.revoked_at !== null) {
        return refreshErrorResponse(ctx, 'invalid_session', 'Session has been revoked.', 401);
      }
      const prevRotationAt = session.previous_rotation_at;
      const withinGrace =
        prevRotationAt !== null &&
        ctx.now.getTime() - new Date(prevRotationAt).getTime() < RACE_GRACE_MS;
      if (!withinGrace) {
        // OWASP ASVS V3.5.5 token-family revoke (F-XCC-AD-NO-FAMILY-
        // REVOKE-001 + F-XCC-AD-NO-AUDIT-002 fix). Pattern A-in-tx —
        // revoke + audit + email-emit roll back together.
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE sessions
                   SET revoked_at = ${now.toISOString()}::timestamptz,
                       revoked_reason = ${TOKEN_REUSE_REVOCATION_REASON}
                 WHERE id = ${session.id}
                   AND revoked_at IS NULL`,
          );

          const userLookup = await tx.execute<{
            email: string;
            firm_id: string;
          }>(
            sql`SELECT email, firm_id
                  FROM firm_users
                 WHERE id = ${session.user_id}
                 LIMIT 1`,
          );
          const userRow = userLookup.rows[0];

          const auditCtx = buildAuditContext({
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            requestId: ctx.requestId,
          });

          if (userRow !== undefined) {
            await writeAudit(tx, {
              action: 'firm_user.session.reuse_detected',
              actor: firmUserActor({
                id: session.user_id,
                label: userRow.email,
                firmId: userRow.firm_id,
              }),
              target: noTarget(),
              context: auditCtx,
              meta: {
                sessionId: session.id,
                userId: session.user_id,
                replayedHashPrefix: tokenHash.slice(0, 12),
              },
              ts: now,
            });

            await emitSecurityEvent({
              db: tx,
              eventType: 'firm_user.session_reuse_detected',
              subject: { kind: 'firm_user', id: session.user_id },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                email: userRow.email,
                displayName: userRow.email.split('@')[0] ?? 'there',
                sessionId: session.id,
              },
              now,
            });
          }
        });

        return refreshErrorResponse(ctx, 'invalid_session', 'Refresh token has been rotated.', 401);
      }
      return NextResponse.json(
        { expiresAt: session.expires_at },
        {
          status: 200,
          headers: {
            'x-request-id': ctx.requestId,
            'cache-control': 'no-store',
          },
        },
      );
    }

    // --- 3. Verify session state ---
    if (session.revoked_at !== null) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Dashboard session has been revoked.', 401);
    }

    if (new Date(session.refresh_expires_at) < now) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Dashboard refresh token has expired.', 401);
    }

    // --- 4. Verify firm user + firm state ---
    const userResult = await db.execute<{
      id: string;
      firm_id: string;
      email: string;
      role: string;
      locked_at: string | null;
    }>(
      sql`SELECT id, firm_id, email, role, locked_at::text
       FROM firm_users
       WHERE id = ${session.user_id}
       LIMIT 1`,
    );
    const firmUser = userResult.rows[0] as {
      id: string;
      firm_id: string;
      email: string;
      role: string;
      locked_at: string | null;
    } | undefined;

    if (!firmUser) {
      return refreshErrorResponse(ctx, 'invalid_session', 'User not found.', 401);
    }
    if (firmUser.locked_at !== null) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Account is locked.', 401);
    }

    // Verify firm is not deleted
    const firmResult = await db.execute<{
      id: string;
      deleted_at: string | null;
    }>(
      sql`SELECT id, deleted_at::text
       FROM firms
       WHERE id = ${firmUser.firm_id}
       LIMIT 1`,
    );
    const firm = firmResult.rows[0] as {
      id: string;
      deleted_at: string | null;
    } | undefined;

    if (!firm || firm.deleted_at !== null) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Firm not found.', 401);
    }

    // --- 5. Sign new access token ---
    const authConfig = getAuthConfig();
    const jwtConfig: JwtConfig = authConfig;

    const signed = await signAccessToken(
      { kind: 'firm', sub: firmUser.id, firmId: firmUser.firm_id, role: firmUser.role as FirmUserRole },
      jwtConfig,
      now,
    );

    // --- 6. Generate new refresh token ---
    const newRefresh = generateRefreshToken();
    const newRefreshExpiresAt = new Date(
      now.getTime() + authConfig.jwtRefreshTtlSeconds * 1000,
    );

    // --- 7. Update session row (CAS + previous-hash stash) ---
    //
    // See customer refresh for the full commentary. Stash the old
    // hash + rotation time so a sub-ms-later concurrent request
    // matches it at step 2 and takes the race-loss branch.
    const newVersion = session.refresh_token_version + 1;
    const updateResult = await db.execute<{ id: string }>(
      sql`UPDATE sessions
       SET jwt_jti = ${signed.jti},
           refresh_token_hash = ${newRefresh.tokenHash},
           refresh_token_version = ${newVersion},
           expires_at = ${signed.expiresAt.toISOString()},
           refresh_expires_at = ${newRefreshExpiresAt.toISOString()},
           last_seen_at = ${now.toISOString()},
           previous_refresh_token_hash = ${session.refresh_token_hash},
           previous_rotation_at = ${now.toISOString()}
       WHERE id = ${session.id}
         AND refresh_token_version = ${session.refresh_token_version}
         AND revoked_at IS NULL
       RETURNING id`,
    );

    if (updateResult.rows.length === 0) {
      const winnerResult = await db.execute<{
        expires_at: string;
        revoked_at: string | null;
      }>(
        sql`SELECT expires_at::text, revoked_at::text
             FROM sessions
            WHERE id = ${session.id}
            LIMIT 1`,
      );
      const winner = winnerResult.rows[0];
      if (!winner || winner.revoked_at !== null) {
        return refreshErrorResponse(ctx, 'invalid_session', 'Session has been invalidated.', 401);
      }
      return NextResponse.json(
        { expiresAt: winner.expires_at },
        {
          status: 200,
          headers: {
            'x-request-id': ctx.requestId,
            'cache-control': 'no-store',
          },
        },
      );
    }

    // --- 8. Audit ---
    //
    // Refresh rotation success → audit trail entry. Mirrors the
    // customer refresh pattern (which reuses `customer.session.created`
    // with meta discriminator); firm side uses the dedicated
    // `firm_user.session.refreshed` action so queries filtering on
    // `actor_kind = 'firm_user'` can project refresh events without
    // a meta discriminator.
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'firm_user.session.refreshed',
      actor: firmUserActor({
        id: firmUser.id,
        label: firmUser.email,
        firmId: firmUser.firm_id,
      }),
      target: noTarget(),
      context: auditCtx,
      meta: {
        sessionId: session.id,
        version: newVersion,
      },
      ts: now,
    });

    // --- 9. Build response with new cookies ---
    const isProduction = process.env.NODE_ENV === 'production';

    const response = NextResponse.json(
      { expiresAt: signed.expiresAt.toISOString() },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

    response.cookies.set(DASHBOARD_ACCESS_COOKIE, signed.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    // Refresh cookie honours the original login `rememberMe` intent
    // across rotations (AUD-FRM-AUTH-003). `rememberMe=false` → omit
    // maxAge so the cookie dies when the browser closes; `true` →
    // persistent up to refresh TTL.
    const refreshCookieOptions: Parameters<typeof response.cookies.set>[2] = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/auth/refresh',
    };
    if (session.remember_me) {
      refreshCookieOptions.maxAge = authConfig.jwtRefreshTtlSeconds;
    }
    response.cookies.set(DASHBOARD_REFRESH_COOKIE, newRefresh.token, refreshCookieOptions);

    return response;
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
