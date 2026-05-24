/**
 * POST /api/customer/auth/reset-password
 *
 * Consume a password reset 6-digit code and set a new password.
 * Public (unauthenticated) endpoint.
 *
 * Input: { email, code, password }
 * Returns a structured status response.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
  maybeRateLimitResponse,
} from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { resetPassword } from '@/lib/customer/reset';
import { emailSchema, newPasswordSchema, verificationCodeSchema } from '@/lib/validation/auth';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResetPasswordBody = z.object({
  email: emailSchema,
  code: verificationCodeSchema,
  password: newPasswordSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_reset_password', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, ResetPasswordBody);

    // --- 1. Reset password. Audit + notification-email dispatch
    //        happen asynchronously via the security-events outbox,
    //        emitted inside `resetPassword`'s mutation transaction.
    const authConfig = getAuthConfig();
    const customerConfig = getCustomerAuthConfig();
    const result = await resetPassword(
      db,
      authConfig,
      body.email,
      body.code,
      body.password,
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      body.email.split('@')[0] ?? 'User',
      customerConfig.maxCodeAttempts,
      () => ctx.now,
    );

    // --- 2. Handle result ---
    switch (result.status) {
      case 'reset':
        return ctx.json(
          { status: 'reset', message: 'Password has been reset. Please log in.' },
          200,
        );

      case 'expired':
        return ctx.errorJson(
          'code_expired',
          'Reset code has expired. Please request a new one.',
          400,
          { status: 'expired' },
        );

      case 'invalid':
        return ctx.errorJson(
          'code_invalid',
          'Invalid reset code. Please try again.',
          400,
          { status: 'invalid' },
        );

      case 'used':
        return ctx.errorJson(
          'validation_failed',
          'This reset code has already been used.',
          400,
          { status: 'used' },
        );

      case 'max_attempts':
        return ctx.errorJson(
          'code_max_attempts',
          'Too many wrong attempts. Please request a new code.',
          429,
          { status: 'max_attempts' },
          MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
        );
    }
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
