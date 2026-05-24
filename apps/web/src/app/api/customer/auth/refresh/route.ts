/**
 * POST /api/customer/auth/refresh
 *
 * Rotate the customer refresh token and issue a new access token.
 * The refresh token is read from the `__crivacy_crt` cookie (not the
 * request body), this prevents XSS-stolen tokens from being used
 * outside the browser.
 *
 * Token rotation pattern:
 *   1. Read `__crivacy_crt` cookie
 *   2. Hash it with sha256
 *   3. Find session row where refresh_token_hash matches and not revoked
 *   4. Verify session not expired (refresh_expires_at > now)
 *   5. Verify customer still valid (not banned/locked/deleted)
 *   6. Sign new access token
 *   7. Generate new refresh token
 *   8. Update session row (new jti, new hash, bump version)
 *   9. Set new cookies
 *  10. Return 200
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import type { JwtConfig } from '@/lib/auth/jwt';
import { generateRefreshToken, sha256, signAccessToken } from '@/lib/auth/jwt';
import { getDatabaseClient } from '@/lib/db/client';
import { getCustomerAuthConfig } from '@/lib/customer/config';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget, uuidTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { TOKEN_REUSE_REVOCATION_REASON } from '@/lib/auth/sessions';
import { emitSecurityEvent } from '@/lib/security-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { CUSTOMER_ACCESS_COOKIE, CUSTOMER_REFRESH_COOKIE } from '@/lib/auth/cookie-names';

const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;

/**
 * Build an error response that also clears auth cookies.
 *
 * When a refresh attempt fails (session revoked, customer banned, token
 * expired, etc.), the browser still holds the httpOnly auth cookies.
 * The Edge Middleware checks cookie PRESENCE to decide whether a user is
 * "logged in", if the cookies remain, it redirects the user away from
 * `/login`, creating an infinite redirect loop.
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
    path: '/api/customer/auth/refresh',
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
    // Refresh is Turnstile-less (no user interaction) so a stolen
    // refresh cookie could mint unlimited access tokens without
    // this cap. `customer_refresh` bucket: 20/60s, leaves ~5x
    // headroom above proactive-refresh + reactive-401 legitimate
    // traffic while shutting down brute rotation.
    const limited = await maybeRateLimitResponse(db, 'customer_refresh', ctx.ip, now);
    if (limited !== null) return limited;

    // --- 1. Extract refresh token from cookie ---
    const refreshCookie = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
    if (refreshCookie === undefined || refreshCookie.length === 0) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Refresh token not found.', 401);
    }

    // --- 2. Hash and look up session ---
    //
    // We look up by CURRENT hash first; if that misses we allow a
    // match against the PREVIOUS hash within a 5s grace window.
    // That lets a concurrent-tab race loser (whose browser cookie
    // is the just-rotated old value) detect the race and return
    // 200 without re-rotating, see the race-loss branch below.
    // Outside the grace window a previous-hash match is treated as
    // a stale / replayed token and falls back to 401.
    const tokenHash = sha256(refreshCookie);
    const RACE_GRACE_MS = 5_000;

    const sessionResult = await db.execute<{
      id: string;
      customer_id: string;
      refresh_token_hash: string;
      refresh_token_version: number;
      refresh_expires_at: string;
      revoked_at: string | null;
      previous_refresh_token_hash: string | null;
      previous_rotation_at: string | null;
      expires_at: string;
      remember_me: boolean;
    }>(
      sql`SELECT id, customer_id, refresh_token_hash, refresh_token_version::int,
           refresh_expires_at::text, revoked_at::text,
           previous_refresh_token_hash,
           previous_rotation_at::text,
           expires_at::text,
           remember_me
       FROM customer_sessions
       WHERE refresh_token_hash = ${tokenHash}
          OR previous_refresh_token_hash = ${tokenHash}
       LIMIT 1`,
    );
    const session = sessionResult.rows[0] as {
      id: string;
      customer_id: string;
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
      return refreshErrorResponse(ctx, 'invalid_session', 'Invalid refresh token.', 401);
    }

    // --- 2a. Race-loss detection ---
    //
    // The row matched by previous_refresh_token_hash, the caller's
    // cookie was just rotated away. If the rotation was inside the
    // grace window AND the session is alive, return 200 with the
    // winner's access-token expiry and NO Set-Cookie header so the
    // winner's fresh cookies are not clobbered. Anything else is a
    // stale token presentation.
    if (session.refresh_token_hash !== tokenHash) {
      // Auto-idempotency pin (F-XCC-AD-FAMILY-REVOKE-001 fix): if the
      // matched row is already revoked, return 401 here BEFORE the
      // stale-replay branch fires its UPDATE + audit + emit. A 2nd
      // post-grace replay against an already-revoked row hits this
      // line and never re-enters the reuse-detection logic, audit
      // + email enqueue happen exactly once per family-compromise
      // event. (See `lib/audit/actions.ts::customer.session.reuse_detected`
      // catalog comment.)
      if (session.revoked_at !== null) {
        return refreshErrorResponse(ctx, 'invalid_session', 'Session has been revoked.', 401);
      }
      const prevRotationAt = session.previous_rotation_at;
      const withinGrace =
        prevRotationAt !== null &&
        ctx.now.getTime() - new Date(prevRotationAt).getTime() < RACE_GRACE_MS;
      if (!withinGrace) {
        // OWASP ASVS V3.5.5 token-family revoke (F-XCC-AD-NO-FAMILY-
        // REVOKE-001 + F-XCC-AD-NO-AUDIT-002 fix). The cookie matched
        // `previous_refresh_token_hash` outside the 5s race-grace
        // window, that's a stale token presentation, almost always
        // a stolen-cookie replay. Revoke the session row + write the
        // audit row + emit the security-event email leg, all inside
        // a single tx so they roll back together (Pattern A-in-tx,
        // NIST SP 800-92).
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE customer_sessions
                   SET revoked_at = ${now.toISOString()}::timestamptz,
                       revoked_reason = ${TOKEN_REUSE_REVOCATION_REASON}
                 WHERE id = ${session.id}
                   AND revoked_at IS NULL`,
          );

          const customerLookup = await tx.execute<{
            email: string | null;
            display_name: string | null;
          }>(
            sql`SELECT email, display_name FROM customers WHERE id = ${session.customer_id} LIMIT 1`,
          );
          const customerRow = customerLookup.rows[0];

          const auditCtx = buildAuditContext({
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            requestId: ctx.requestId,
          });
          await writeAudit(tx, {
            action: 'customer.session.reuse_detected',
            actor: systemActor('customer-auth'),
            target: uuidTarget({ kind: 'customer', id: session.customer_id }),
            context: auditCtx,
            meta: {
              sessionId: session.id,
              customerId: session.customer_id,
              replayedHashPrefix: tokenHash.slice(0, 12),
            },
            ts: now,
          });

          if (customerRow !== undefined && customerRow.email !== null) {
            await emitSecurityEvent({
              db: tx,
              eventType: 'customer.session_reuse_detected',
              subject: { kind: 'customer', id: session.customer_id },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                email: customerRow.email,
                displayName:
                  customerRow.display_name ??
                  customerRow.email.split('@')[0] ??
                  'there',
                sessionId: session.id,
              },
              now,
            });
          }
        });

        return refreshErrorResponse(ctx, 'invalid_session', 'Refresh token has been rotated.', 401);
      }
      return NextResponse.json(
        {
          customerId: session.customer_id,
          expiresAt: session.expires_at,
        },
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
      return refreshErrorResponse(ctx, 'invalid_session', 'Session has been revoked.', 401);
    }

    if (new Date(session.refresh_expires_at) < now) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Refresh token has expired.', 401);
    }

    // --- 4. Verify customer state ---
    const customerResult = await db.execute<{
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
    }>(
      sql`SELECT id, email, status, deleted_at::text
       FROM customers
       WHERE id = ${session.customer_id}
       LIMIT 1`,
    );
    const customer = customerResult.rows[0] as {
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
    } | undefined;

    if (!customer || customer.deleted_at !== null) {
      return refreshErrorResponse(ctx, 'invalid_session', 'Account not found.', 401);
    }
    if (customer.status === 'banned') {
      return refreshErrorResponse(ctx, 'account_banned', 'Account has been banned. Please contact support.', 403);
    }
    if (customer.status === 'suspended') {
      // AUD-X-ERROR-001: reversible suspend vs terminal ban.
      return refreshErrorResponse(ctx, 'account_suspended', 'Account is suspended. Contact support to review the restriction.', 403);
    }
    if (customer.status === 'locked') {
      return refreshErrorResponse(ctx, 'account_locked', 'Account is temporarily locked.', 423);
    }

    // --- 5. Sign new access token ---
    const authConfig = getAuthConfig();
    const jwtConfig: JwtConfig = authConfig;

    const signed = await signAccessToken(
      { kind: 'customer', sub: customer.id, role: 'customer' },
      jwtConfig,
      now,
    );

    // --- 6. Generate new refresh token ---
    const newRefresh = generateRefreshToken();
    const customerConfig = getCustomerAuthConfig();
    const newRefreshExpiresAt = new Date(
      now.getTime() + customerConfig.customerRefreshTtlSeconds * 1000,
    );

    // --- 7. Update session row (CAS + previous-hash stash) ---
    //
    // Two defences combined:
    //   (a) CAS on `refresh_token_version`, two concurrent tabs
    //       that both passed step 2 with the same current hash race
    //       here; only one UPDATE flips the version.
    //   (b) We write the OLD hash into `previous_refresh_token_hash`
    //       with `previous_rotation_at = now`. A subsequent request
    //       within the 5s grace window still sees it at step 2 and
    //       lands in the race-loss branch there.
    //
    // The CAS loser in (a) would also be a race loss, just caught
    // half a round-trip later. Returning the race-loss 200 directly
    // here avoids a second round trip through step 2.
    const newVersion = session.refresh_token_version + 1;
    const updateResult = await db.execute<{ id: string }>(
      sql`UPDATE customer_sessions
       SET jwt_jti = ${signed.jti},
           refresh_token_hash = ${newRefresh.tokenHash},
           refresh_token_version = ${newVersion},
           expires_at = ${signed.expiresAt.toISOString()},
           refresh_expires_at = ${newRefreshExpiresAt.toISOString()},
           last_active_at = ${now.toISOString()},
           previous_refresh_token_hash = ${session.refresh_token_hash},
           previous_rotation_at = ${now.toISOString()}
       WHERE id = ${session.id}
         AND refresh_token_version = ${session.refresh_token_version}
         AND revoked_at IS NULL
       RETURNING id`,
    );

    if (updateResult.rows.length === 0) {
      // CAS race loss, someone else just rotated. Re-read the
      // session to get the winner's access-token expiry and return
      // 200 WITHOUT any Set-Cookie so the winner's fresh cookies
      // reach the browser unopposed.
      const winnerResult = await db.execute<{
        expires_at: string;
        revoked_at: string | null;
      }>(
        sql`SELECT expires_at::text, revoked_at::text
             FROM customer_sessions
            WHERE id = ${session.id}
            LIMIT 1`,
      );
      const winner = winnerResult.rows[0];
      if (!winner || winner.revoked_at !== null) {
        return refreshErrorResponse(ctx, 'invalid_session', 'Session has been invalidated.', 401);
      }
      return NextResponse.json(
        {
          customerId: customer.id,
          expiresAt: winner.expires_at,
        },
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
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'customer.session.created',
      actor: systemActor('customer-auth'),
      target: noTarget(),
      context: auditCtx,
      meta: {
        customerId: customer.id,
        sessionId: session.id,
        version: newVersion,
        action: 'refresh',
      },
      ts: now,
    });

    // --- 9. Build response with new cookies ---
    const isProduction = process.env.NODE_ENV === 'production';

    const responseBody = {
      customerId: customer.id,
      expiresAt: signed.expiresAt.toISOString(),
    };

    const response = NextResponse.json(responseBody, {
      status: 200,
      headers: {
        'x-request-id': ctx.requestId,
        'cache-control': 'no-store',
      },
    });

    // Access token cookie
    response.cookies.set(ACCESS_TOKEN_COOKIE, signed.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    // Refresh cookie honours the original login `rememberMe` intent
    // across rotations (AUD-CUS-AUTH-002). `rememberMe=false` → omit
    // maxAge so the cookie dies when the browser closes; `true` →
    // persistent up to refresh TTL.
    const refreshCookieOptions: Parameters<typeof response.cookies.set>[2] = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/customer/auth/refresh',
    };
    if (session.remember_me) {
      refreshCookieOptions.maxAge = customerConfig.customerRefreshTtlSeconds;
    }
    response.cookies.set(REFRESH_TOKEN_COOKIE, newRefresh.token, refreshCookieOptions);

    return response;
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
