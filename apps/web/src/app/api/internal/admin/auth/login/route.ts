/**
 * POST /api/internal/admin/auth/login, single-step admin login (firm parity).
 *
 * Verifies email + password + Turnstile, plus an optional TOTP code
 * when the admin has enrolled. Mirrors the firm-dashboard
 * `/api/internal/auth/login` request/response shape:
 *
 *   - email + password (no totpCode) + TOTP-enrolled → 401 `totp_required`
 *     (UI reveals the TOTP field on the same form)
 *   - email + password + totpCode (TOTP-enrolled, valid)              → cookies set
 *   - email + password (TOTP not enrolled)                            → cookies set
 *
 * The pre-MP-A two-step variant (challenge token + 2-min TTL + step-2
 * verify-totp endpoint) is gone, same SoT pattern as firm login,
 * driven by `handleAdminLogin` in `server/handlers/admin-auth.ts`.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { AuthError } from '@/lib/auth/errors';
import { getCustomerAuthConfig } from '@/lib/customer/config';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';
import { emailSchema, existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';
import { turnstileTokenSchema } from '@/lib/validation/admin';
import { handleAdminLogin } from '@/server/handlers';
import { publicRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminUserByEmail,
  findAdminUserByIdForMiddleware,
  findSessionByJti,
  incrementAdminFailedLoginOrLock,
  insertAdminSession,
  resetAdminFailedLogin,
  revokeAdminSession,
  revokeAllAdminSessions,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LoginBody = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  // Optional. Required only when the admin has TOTP enrolled, first
  // submit can omit it; a 401 `totp_required` response tells the UI
  // to reveal the TOTP input and the user resends the same form
  // with the 6-digit code filled in.
  totpCode: totpCodeSchema.optional(),
  turnstileToken: turnstileTokenSchema,
});

export const POST = publicRoute(async (ctx) => {
  const limited = await maybeRateLimitResponse(ctx.db, 'admin_login', ctx.ip, ctx.now);
  if (limited) return limited;

  const input = await parseBody(ctx.request, LoginBody);

  // Verify Turnstile token, central config read shared with customer
  // + firm login. Admin was historically reading `process.env`
  // directly with an empty-string fallback (AUD-ADM-AUTH-001); the
  // central helper throws at startup if the env is missing, closing
  // the silent-bypass risk.
  const turnstileResult = await verifyTurnstileToken(
    input.turnstileToken,
    getCustomerAuthConfig().turnstileSecretKey,
    ctx.ip,
  );
  if (!turnstileResult.success) {
    await auditTurnstileFailure(
      ctx.db,
      { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, now: ctx.now },
      'admin_user',
      {
        endpoint: 'login',
        turnstileErrorCodes: turnstileResult.errorCodes,
        identifier: input.email,
      },
    );
    return ctx.errorJson('turnstile_failed', 'Bot verification failed. Please try again.', 403);
  }

  try {
    const result = await handleAdminLogin(
      {
        db: ctx.db,
        authConfig: getAuthConfig(),
        clock: () => ctx.now,
        clientIp: ctx.ip,
        findAdminUserByEmail,
        findAdminUserById: findAdminUserByIdForMiddleware,
        findSessionByJti,
        insertSession: insertAdminSession,
        revokeSession: revokeAdminSession,
        revokeAllUserSessions: revokeAllAdminSessions,
        updateSessionAfterRotate: async () => {},
        incrementFailedLoginOrLock: incrementAdminFailedLoginOrLock,
        resetFailedLogin: resetAdminFailedLogin,
      },
      {
        email: input.email,
        password: input.password,
        ...(input.totpCode !== undefined ? { totpCode: input.totpCode } : {}),
      },
    );

    // TOTP either was not enrolled OR the inline TOTP verify already
    // succeeded, both paths land here with cookies to set.
    const isProduction = process.env.NODE_ENV === 'production';
    const authConfig = getAuthConfig();

    const response = NextResponse.json(
      {
        totpRequired: false,
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
      },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

    response.cookies.set(ADMIN_ACCESS_COOKIE, result.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    // Admin refresh cookie is SESSION-ONLY (no `maxAge`) by design.
    // Platform operators re-login every browser session: admin is
    // high-privilege (impersonation, firm management, RBAC), so a
    // 30-day persistent cookie is an unacceptable attacker window.
    // There is no remember-me switch on the admin login, matches
    // the hardened-console pattern used by AWS + GCP consoles.
    // Server-side `refresh_expires_at` on the session row still
    // enforces an absolute upper bound; the session cookie just
    // guarantees the cookie is discarded when the browser closes.
    response.cookies.set(ADMIN_REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/admin/auth/refresh',
    });

    return response;
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.code === 'invalid_password') {
        return ctx.errorJson('unauthenticated', err.message, 401);
      }
      // `account_locked` only fires post-verify now (owner proved
      // password knowledge), so surfacing the 423 + retry-after
      // message is safe and good UX, not an enumeration oracle.
      if (err.code === 'account_locked') {
        return ctx.errorJson('account_locked', err.message, 423);
      }
      // TOTP gating signals, same wire shape as the firm login
      // route so the shared admin login UI can mirror the firm
      // dashboard's "reveal the field on 401" flow.
      if (err.code === 'totp_not_enrolled') {
        return ctx.errorJson('totp_required', err.message, 401);
      }
      if (err.code === 'invalid_totp_code') {
        return ctx.errorJson('invalid_totp_code', err.message, 401);
      }
    }
    throw err;
  }
});
