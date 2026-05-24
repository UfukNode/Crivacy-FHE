/**
 * POST /api/customer/auth/verify-email
 *
 * Verify a customer's email address using a 6-digit code.
 * Public (unauthenticated) endpoint.
 *
 * Input: { email, code }
 * Returns a structured status response.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
  maybeRateLimitResponse,
} from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { verifyEmail } from '@/lib/customer/verify-email';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { emailSchema, verificationCodeSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VerifyEmailBody = z.object({
  email: emailSchema,
  code: verificationCodeSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_verify_email', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, VerifyEmailBody);
    const customerConfig = getCustomerAuthConfig();

    // --- 1. Verify email code ---
    const result = await verifyEmail(
      db,
      body.email,
      body.code,
      customerConfig.maxCodeAttempts,
      () => ctx.now,
    );

    // --- 2. Handle result ---
    switch (result.status) {
      case 'verified': {
        const auditCtx = buildAuditContext({
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        });
        await writeAudit(db, {
          action: 'customer.email_verified',
          actor: systemActor('customer-auth'),
          target: noTarget(),
          context: auditCtx,
          meta: { customerId: result.customerId },
          ts: ctx.now,
        });

        return ctx.json(
          { status: 'verified', message: 'Email verified successfully.' },
          200,
        );
      }

      case 'expired':
        return ctx.errorJson(
          'code_expired',
          'Verification code has expired. Please request a new one.',
          400,
          { status: 'expired' },
        );

      case 'invalid':
        return ctx.errorJson(
          'code_invalid',
          'Invalid verification code. Please try again.',
          400,
          { status: 'invalid' },
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
