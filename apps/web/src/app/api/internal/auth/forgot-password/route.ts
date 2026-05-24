/**
 * POST /api/internal/auth/forgot-password
 *
 * Firm-user forgot-password entry point. Mirrors
 * `/api/customer/auth/forgot-password`: always returns 200 with a
 * generic message, independent of whether the email is registered,
 * so email-enumeration attacks can't use timing or status codes as
 * a signal.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { RESET_CODE_TTL_SECONDS } from '@/lib/customer/verification-code';
import { getDatabaseClient } from '@/lib/db/client';
import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { passwordResetEmail } from '@/lib/email/templates';
import { requestFirmUserPasswordReset } from '@/lib/firm-auth/forgot';
import { emailSchema } from '@/lib/validation/auth';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ForgotPasswordBody = z.object({
  email: emailSchema,
});

const GENERIC_SUCCESS = {
  message: "If this email is registered, you'll receive a password reset code.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'firm_forgot_password', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, ForgotPasswordBody);

    const result = await requestFirmUserPasswordReset(
      db,
      body.email,
      RESET_CODE_TTL_SECONDS,
      ctx.ip,
      () => ctx.now,
    );

    if (result.firmUserId !== null && result.resetCode !== null) {
      await writeAudit(db, {
        action: 'firm_user.password_reset_requested',
        actor: systemActor('firm-auth'),
        target: noTarget(),
        context: buildAuditContext({
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        }),
        meta: { firmUserId: result.firmUserId },
        ts: ctx.now,
      });

      const displayName = body.email.split('@')[0] ?? 'there';
      const emailContent = passwordResetEmail({
        displayName,
        code: result.resetCode,
        expiresInMinutes: Math.round(RESET_CODE_TTL_SECONDS / 60),
      });
      await enqueueEmailFromRoute(db, {
        to: body.email,
        content: emailContent,
        emailType: 'password_reset',
        userId: result.firmUserId,
      });
    }

    return ctx.json(GENERIC_SUCCESS, 200);
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
