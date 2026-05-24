/**
 * POST /api/internal/auth/login
 *
 * Authenticate a firm user with email + password + optional TOTP.
 * On success sets httpOnly cookies (__crivacy_at + __crivacy_art).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { DASHBOARD_ACCESS_COOKIE, DASHBOARD_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { handleLogin } from '@/server/handlers';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForDashboard,
  findSessionByJti,
  findUserByEmail,
  findUserByIdForDashboard,
  incrementFailedLoginOrLock,
  insertDashboardSession,
  resetFailedLogin,
  revokeAllDashboardSessions,
  revokeDashboardSession,
  saveTotpSecret,
  updateSessionAfterRotate,
} from '@/server/repositories';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';
import { emailSchema, existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LoginBody = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  totpCode: totpCodeSchema.optional(),
  /**
   * Recovery code (dashed `XXXXX-XXXXX` or 10-char compact). Used
   * INSTEAD OF `totpCode` when the user has lost access to their
   * authenticator app. Normalised + hashed server-side, the raw
   * value is never stored. Min 10 (compact form), max 32 keeps a
   * generous ceiling for whitespace-padded pastes.
   */
  recoveryCode: z.string().min(10).max(32).optional(),
  // Required, credential-accepting public endpoint. Shares the
  // single Cloudflare Turnstile secret with the customer audience
  // (it's one CF site key, one secret; the config key is in
  // customer-config only for historical reasons).
  turnstileToken: z.string().min(1).max(4096),
  // Opt-in persistent session. When false (default), the refresh
  // cookie is session-only, gone when the browser closes. When
  // true, it persists for `AUTH_JWT_REFRESH_TTL_SECONDS` (default
  // 30 days), matching the customer login UX + central auth config.
  rememberMe: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'firm_login', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, LoginBody);

    // --- Turnstile verify (required) ---
    const turnstile = await verifyTurnstileToken(
      body.turnstileToken,
      getCustomerAuthConfig().turnstileSecretKey,
      ctx.ip,
    );
    if (!turnstile.success) {
      await auditTurnstileFailure(
        db,
        { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, now: ctx.now },
        'firm_user',
        {
          endpoint: 'login',
          turnstileErrorCodes: turnstile.errorCodes,
          identifier: body.email,
        },
      );
      return ctx.errorJson('turnstile_failed', 'Captcha verification failed.', 403);
    }

    const result = await handleLogin(
      {
        db,
        authConfig: getAuthConfig(),
        findUserByEmail,
        findUserById: findUserByIdForDashboard,
        findFirmById: findFirmByIdForDashboard,
        findSessionByJti,
        insertSession: insertDashboardSession,
        revokeSession: revokeDashboardSession,
        revokeAllUserSessions: revokeAllDashboardSessions,
        updateSessionAfterRotate,
        incrementFailedLoginOrLock,
        resetFailedLogin,
        saveTotpSecret,
      },
      {
        email: body.email,
        password: body.password,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        rememberMe: body.rememberMe,
        ...(body.totpCode !== undefined ? { totpCode: body.totpCode } : {}),
        ...(body.recoveryCode !== undefined ? { recoveryCode: body.recoveryCode } : {}),
      },
    );

    // Build response with httpOnly cookies (same pattern as customer login)
    const isProduction = process.env.NODE_ENV === 'production';
    const authConfig = getAuthConfig();

    const response = NextResponse.json(
      {
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
        totpRequired: result.totpRequired,
      },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

    // Access token cookie
    response.cookies.set(DASHBOARD_ACCESS_COOKIE, result.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    // Refresh token cookie, scoped to dashboard refresh path.
    // `rememberMe=true` persists for the full refresh TTL (default
    // 30 days via AUTH_JWT_REFRESH_TTL_SECONDS). `rememberMe=false`
    // omits `maxAge` entirely → browser treats it as a session
    // cookie and drops it on close. Mirrors the customer login UX
    // and the central auth-config TTL, no firm-specific env.
    const refreshCookieOptions: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: string;
      maxAge?: number;
    } = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/auth/refresh',
    };
    if (body.rememberMe) {
      refreshCookieOptions.maxAge = authConfig.jwtRefreshTtlSeconds;
    }
    response.cookies.set(DASHBOARD_REFRESH_COOKIE, result.refreshToken, refreshCookieOptions);

    return response;
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
