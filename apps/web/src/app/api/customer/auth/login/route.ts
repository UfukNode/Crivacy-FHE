/**
 * POST /api/customer/auth/login
 *
 * Authenticate a customer with email + password. Public endpoint.
 *
 * On success:
 * - Revokes ALL other sessions (single session enforcement)
 * - Sets httpOnly cookies (__crivacy_ct + __crivacy_crt)
 * - If rememberMe: refresh cookie = persistent (30d Max-Age)
 * - If !rememberMe: refresh cookie = session (no Max-Age, deleted on browser close)
 * - Writes audit log
 * - Returns customer ID + token expiry
 *
 * On failure, error mapper translates CustomerError codes.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { loginCustomer } from '@/lib/customer/login';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';
import { emailSchema, existingPasswordSchema } from '@/lib/validation/auth';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LoginBody = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  rememberMe: z.boolean().optional().default(false),
  // Required, login is a credential-accepting public endpoint, so
  // scripted brute-force must go through Turnstile the same way
  // register / forgot-password already do. Dev without the env still
  // works via the always-pass test key + verify-side dev bypass.
  turnstileToken: z.string().min(1).max(4096),
});

import { CUSTOMER_ACCESS_COOKIE, CUSTOMER_REFRESH_COOKIE } from '@/lib/auth/cookie-names';

const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_login', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, LoginBody);

    // --- 1. Verify Turnstile (required) ---
    const customerConfig = getCustomerAuthConfig();
    const turnstile = await verifyTurnstileToken(
      body.turnstileToken,
      customerConfig.turnstileSecretKey,
      ctx.ip,
    );
    if (!turnstile.success) {
      await auditTurnstileFailure(
        db,
        { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, now: ctx.now },
        'customer',
        {
          endpoint: 'login',
          turnstileErrorCodes: turnstile.errorCodes,
          identifier: body.email,
        },
      );
      return ctx.errorJson('turnstile_failed', 'Captcha verification failed.', 403);
    }

    // --- 2. Authenticate (includes single-session enforcement) ---
    const authConfig = getAuthConfig();
    const result = await loginCustomer(
      db,
      authConfig,
      customerConfig,
      {
        email: body.email,
        password: body.password,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        rememberMe: body.rememberMe,
      },
      () => ctx.now,
    );

    // --- 3. Audit ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    // AUD-CUS-AUDIT-001: success path customer kimliği eldeyken
    // systemActor'a düşmek yerine customerActor kullan, `actor_kind =
    // 'customer'` sorguları bu row'u doğru kimlikle görür. Failure
    // path (bad password, unknown email) hâlâ `systemActor` kullanır
    // çünkü kimlik henüz resolve edilmemiş.
    await writeAudit(db, {
      action: 'customer.login.success',
      actor: customerActor({
        id: result.customerId,
        label: customerLabel({ email: body.email, id: result.customerId }),
      }),
      target: noTarget(),
      context: auditCtx,
      meta: { sessionId: result.sessionId, rememberMe: result.rememberMe },
      ts: ctx.now,
    });

    // --- 4. Build response with cookies ---
    const isProduction = process.env.NODE_ENV === 'production';

    const responseBody = {
      customerId: result.customerId,
      expiresAt: result.accessTokenExpiresAt.toISOString(),
    };

    const response = NextResponse.json(responseBody, {
      status: 200,
      headers: {
        'x-request-id': ctx.requestId,
        'cache-control': 'no-store',
      },
    });

    // Access token cookie, always the same
    response.cookies.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    // Refresh token cookie:
    // - rememberMe=true: persistent cookie with Max-Age (survives browser close)
    // - rememberMe=false: session cookie (no Max-Age, deleted on browser close)
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
      path: '/api/customer/auth/refresh',
    };

    if (result.rememberMe) {
      refreshCookieOptions.maxAge = customerConfig.customerRememberMeTtlDays * 86400;
    }
    // If !rememberMe, we omit maxAge entirely → session cookie

    response.cookies.set(REFRESH_TOKEN_COOKIE, result.refreshToken, refreshCookieOptions);

    return response;
  } catch (err) {
    if (isParseError(err)) {
      const status =
        err.code === 'payload_too_large'
          ? 413
          : err.code === 'unsupported_media_type'
            ? 415
            : 400;
      return ctx.errorJson(err.code, err.message, status);
    }
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
