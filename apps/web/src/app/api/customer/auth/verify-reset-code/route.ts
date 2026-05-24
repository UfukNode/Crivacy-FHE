/**
 * POST /api/customer/auth/verify-reset-code
 *
 * Customer side of the reset-code pre-validation. Same contract as
 * the firm-user `/api/internal/auth/verify-reset-code` route:
 * verifies a reset code WITHOUT consuming it and returns 200 on
 * success so the UI can gate the "new password" step.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
  maybeRateLimitResponse,
} from '@/lib/auth-rate-limit';
import { getCustomerAuthConfig } from '@/lib/customer/config';
import { verifyResetCode } from '@/lib/customer/reset';
import { getDatabaseClient } from '@/lib/db/client';
import { emailSchema, verificationCodeSchema } from '@/lib/validation/auth';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VerifyBody = z.object({
  email: emailSchema,
  code: verificationCodeSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_verify_reset_code', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, VerifyBody);
    const customerConfig = getCustomerAuthConfig();

    const result = await verifyResetCode(
      db,
      body.email,
      body.code,
      customerConfig.maxCodeAttempts,
      () => ctx.now,
    );

    switch (result.status) {
      case 'valid':
        return ctx.json({ status: 'valid' }, 200);
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
