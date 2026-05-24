/**
 * POST /api/internal/auth/reset-password
 *
 * Firm-user reset-password: consumes a 6-digit code + sets the new
 * password. Every outcome has a discrete error code so the UI can
 * render the right affordance (resend, re-enter code, done).
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
  maybeRateLimitResponse,
} from '@/lib/auth-rate-limit';
import {
  MAX_CODE_ATTEMPTS,
} from '@/lib/customer/verification-code';
import { getDatabaseClient } from '@/lib/db/client';
import { resetFirmUserPassword } from '@/lib/firm-auth/reset';
import {
  emailSchema,
  newPasswordSchema,
  verificationCodeSchema,
} from '@/lib/validation/auth';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

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
    const limited = await maybeRateLimitResponse(db, 'firm_reset_password', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, ResetPasswordBody);
    const authConfig = getAuthConfig();

    const result = await resetFirmUserPassword(
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
      body.email.split('@')[0] ?? 'there',
      MAX_CODE_ATTEMPTS,
      () => ctx.now,
    );

    switch (result.status) {
      case 'reset':
        // Audit + notification email are emitted via the outbox
        // inside `resetFirmUserPassword`'s mutation transaction —
        // see the helper for the atomicity rationale.
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
        return ctx.errorJson('code_invalid', 'Invalid reset code. Please try again.', 400, {
          status: 'invalid',
        });
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
