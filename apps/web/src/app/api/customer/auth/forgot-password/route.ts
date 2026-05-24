/**
 * POST /api/customer/auth/forgot-password
 *
 * Request a password reset 6-digit code via email. Public endpoint.
 *
 * ALWAYS returns 200 with a generic message regardless of whether the
 * email exists, is banned, or is deleted. This prevents email enumeration.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { requestPasswordReset } from '@/lib/customer/forgot';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { passwordResetEmail } from '@/lib/email/templates';
import { emailSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ForgotPasswordBody = z.object({
  email: emailSchema,
  turnstileToken: z.string().min(1).max(4096).optional(),
});

/**
 * Anti-enumeration response. Returned whether the email exists or not.
 */
const GENERIC_SUCCESS = {
  message: "If this email is registered, you'll receive a password reset code.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_forgot_password', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, ForgotPasswordBody);

    // --- 1. Verify Turnstile (optional on resend, user already passed on initial request) ---
    const customerConfig = getCustomerAuthConfig();
    if (body.turnstileToken) {
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
            endpoint: 'forgot-password',
            turnstileErrorCodes: turnstile.errorCodes,
            identifier: body.email,
          },
        );
        return ctx.errorJson('turnstile_failed', 'Captcha verification failed.', 403);
      }
    }

    // --- 2. Request password reset ---
    const result = await requestPasswordReset(
      db,
      body.email,
      customerConfig.resetCodeTtlSeconds,
      ctx.ip,
      () => ctx.now,
    );

    // --- 3. Audit (only if code was generated) ---
    if (result.customerId !== null && result.resetCode !== null) {
      const auditCtx = buildAuditContext({
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      await writeAudit(db, {
        action: 'customer.password_reset_requested',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: { customerId: result.customerId },
        ts: ctx.now,
      });

      // --- Send password reset code email ---
      // Prefer the customer's own display name, "Hi John Doe," reads
      // professional. Fall back to email local-part, then generic
      // "User" for cases where neither is available (AUD-CUS-AUTH-003).
      const emailContent = passwordResetEmail({
        displayName:
          result.customerDisplayName ?? body.email.split('@')[0] ?? 'User',
        code: result.resetCode,
        expiresInMinutes: Math.round(customerConfig.resetCodeTtlSeconds / 60),
      });
      await enqueueEmailFromRoute(db, {
        to: body.email,
        content: emailContent,
        emailType: 'password_reset',
        userId: result.customerId,
      });
    }

    // Always return 200 to prevent enumeration
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
