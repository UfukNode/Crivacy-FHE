/**
 * POST /api/customer/auth/resend-verification
 *
 * Resend a 6-digit email verification code. Public (unauthenticated) endpoint.
 *
 * ALWAYS returns 200 with a generic message regardless of whether the
 * email exists or the customer is already verified. This prevents email
 * enumeration.
 *
 * Flow: validate → verify Turnstile → find customer → check status →
 * rate-limit check → invalidate old codes → generate new code → return.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';
import { CUSTOMER_EMAIL_VERIFICATION_TABLE } from '@/lib/auth/verify-email-code';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { verificationEmail } from '@/lib/email/templates';
import { emailSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResendVerificationBody = z.object({
  email: emailSchema,
  turnstileToken: z.string().min(1).max(4096).optional(),
});

/**
 * Anti-enumeration response.
 */
const GENERIC_SUCCESS = {
  message: "If this email is registered and not yet verified, you'll receive a verification code.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_resend_verification', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, ResendVerificationBody);

    // --- 1. Verify Turnstile (optional, user already passed on register) ---
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
            endpoint: 'resend-verification',
            turnstileErrorCodes: turnstile.errorCodes,
            identifier: body.email,
          },
        );
        return ctx.errorJson('turnstile_failed', 'Captcha verification failed.', 403);
      }
    }

    // --- 2. Find customer ---
    const emailLower = body.email.toLowerCase().trim();
    const customerResult = await db.execute<{
      id: string;
      email: string;
      status: string;
      email_verified_at: string | null;
      deleted_at: string | null;
    }>(
      sql`SELECT id, email, status, email_verified_at::text, deleted_at::text
       FROM customers
       WHERE lower(email) = ${emailLower}
       LIMIT 1`,
    );
    const customer = customerResult.rows[0] as {
      id: string;
      email: string;
      status: string;
      email_verified_at: string | null;
      deleted_at: string | null;
    } | undefined;

    // Silent exit if not found, deleted, or already verified
    if (
      !customer ||
      customer.deleted_at !== null ||
      customer.email_verified_at !== null ||
      customer.status !== 'pending_verification'
    ) {
      return ctx.json(GENERIC_SUCCESS, 200);
    }

    // --- 3. Rate limit: check recent codes ---
    const windowMs = customerConfig.codeRateLimitWindowMinutes * 60 * 1000;
    const rateLimitWindow = new Date(ctx.now.getTime() - windowMs);
    const recentTokens = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count
       FROM email_verification_tokens
       WHERE customer_id = ${customer.id}
         AND created_at > ${rateLimitWindow.toISOString()}`,
    );
    const recentCount = parseInt(
      (recentTokens.rows[0] as { count: string } | undefined)?.count ?? '0',
      10,
    );
    if (recentCount >= customerConfig.maxCodesPerWindow) {
      // Silent success to prevent enumeration, but don't generate a new code
      return ctx.json(GENERIC_SUCCESS, 200);
    }

    // --- 4 + 5. Atomic invalidate-and-issue through the shared primitive.
    const issued = await issueShortLivedToken({
      db,
      table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
      subjectId: customer.id,
      ttlSeconds: customerConfig.verificationCodeTtlSeconds,
      now: ctx.now,
    });

    // --- 6. Send verification code email ---
    const emailContent = verificationEmail({
      displayName: customer.email.split('@')[0] ?? 'User',
      code: issued.rawCode,
      expiresInMinutes: Math.round(customerConfig.verificationCodeTtlSeconds / 60),
    });
    await enqueueEmailFromRoute(db, {
      to: customer.email,
      content: emailContent,
      emailType: 'verification',
      userId: customer.id,
    });

    // --- 7. Audit ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'email.verification_sent',
      actor: systemActor('customer-auth'),
      target: noTarget(),
      context: auditCtx,
      meta: { customerId: customer.id, email: body.email },
      ts: ctx.now,
    });

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
