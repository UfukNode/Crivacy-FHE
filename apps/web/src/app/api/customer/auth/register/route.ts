/**
 * POST /api/customer/auth/register
 *
 * Register a new customer account. Public (unauthenticated) endpoint.
 *
 * Flow: validate body → verify Turnstile → register customer → send
 * 6-digit verification code via email → write audit → return generic
 * success message (anti-enumeration).
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getDatabaseClient } from '@/lib/db/client';
import { getAppUrl } from '@/lib/env/app-url';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { registerCustomer } from '@/lib/customer/register';
import { auditTurnstileFailure, verifyTurnstileToken } from '@/lib/turnstile';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { hashEmail as hashRegistrationIdentifier } from '@/lib/fraud/blacklist';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { registrationAttemptedEmail, verificationEmail } from '@/lib/email/templates';
import { emailSchema, newPasswordSchema } from '@/lib/validation/auth';
import { displayNameSchema } from '@/lib/validation/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RegisterBody = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  displayName: displayNameSchema.optional(),
  turnstileToken: z.string().min(1).max(4096),
  // AUD-X-COMP-006: explicit Terms of Service + Privacy Policy
  // acceptance. Register form MUST include a checkbox the user
  // ticks; payload rejection if absent/falsy. Version tracking
  // handled server-side so the client can't forge an older version.
  agreedToTerms: z.literal(true, {
    message: 'You must agree to the Terms of Service and Privacy Policy.',
  }),
});

/**
 * Anti-enumeration response. Returned whether the registration succeeded,
 * the email was already taken, or the email was blacklisted.
 */
const GENERIC_SUCCESS = {
  message: "If this email is not already registered, you'll receive a verification code.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const limited = await maybeRateLimitResponse(db, 'customer_register', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(request, RegisterBody);

    // --- 1. Verify Turnstile ---
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
          endpoint: 'register',
          turnstileErrorCodes: turnstile.errorCodes,
          identifier: body.email,
        },
      );
      return ctx.errorJson('turnstile_failed', 'Captcha verification failed.', 403);
    }

    // --- 2. Register customer ---
    const authConfig = getAuthConfig();
    // AUD-X-COMP-006: stamp the policy version the subject just
    // agreed to. Falls back to today's date if env is unset so the
    // DB field is never blank, the env should be bumped whenever
    // ToS/Privacy copy changes to force re-acceptance flows later.
    const termsVersion =
      process.env['NEXT_PUBLIC_TOS_VERSION'] ?? ctx.now.toISOString().slice(0, 10);

    const registerParams = {
      email: body.email,
      password: body.password,
      termsVersion,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    };
    const result = await registerCustomer(
      db,
      authConfig,
      registerParams,
      customerConfig.verificationCodeTtlSeconds,
      () => ctx.now,
    );

    // --- 3. Dispatch side effects based on outcome ---
    // Response is identical across all branches (GENERIC_SUCCESS).
    // Branching here controls which *email* goes out:
    //  - created     → verification code to the new account holder
    //  - existing    → "someone tried to register with your email"
    //                  notification to the real owner (per-user email
    //                  rate limit caps abuse)
    //  - blacklisted → nothing; emailing the attacker-controlled
    //                  inbox is counterproductive
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    const appUrl = getAppUrl();

    if (result.kind === 'created') {
      await writeAudit(db, {
        action: 'customer.registered',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: { customerId: result.customerId, email: body.email },
        ts: ctx.now,
      });

      const emailContent = verificationEmail({
        displayName: body.displayName ?? body.email.split('@')[0] ?? 'User',
        code: result.verificationCode,
        expiresInMinutes: Math.round(customerConfig.verificationCodeTtlSeconds / 60),
      });
      await enqueueEmailFromRoute(db, {
        to: body.email,
        content: emailContent,
        emailType: 'verification',
        userId: result.customerId,
      });
    } else if (result.kind === 'existing') {
      // F-A4-J3-001, register-against-existing-email forensic trail.
      // Public response stays opaque (GENERIC_SUCCESS) to defeat
      // enumeration; SOC dashboards still see the recon attempt under
      // `customer.registration_attempt_existing` with `meta.outcome =
      // 'existing'`. Identifier is hashed before storage, the raw
      // email never enters the audit row.
      await writeAudit(db, {
        action: 'customer.registration_attempt_existing',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: {
          outcome: 'existing',
          identifierHash: hashRegistrationIdentifier(body.email),
        },
        ts: ctx.now,
      });

      const notification = registrationAttemptedEmail({
        displayName: body.email.split('@')[0] ?? 'there',
        loginUrl: `${appUrl}/login`,
      });
      await enqueueEmailFromRoute(db, {
        to: body.email,
        content: notification,
        emailType: 'notification',
        userId: result.customerId,
      });
    } else if (result.kind === 'blacklisted') {
      // F-A4-J3-001, blacklist hit: no email goes out (target inbox
      // is attacker-controlled), but the recon attempt is recorded
      // for SOC. `meta.outcome` discriminates from the existing-
      // account branch so dashboards can split fraud-reuse signal
      // from regular collision attempts.
      await writeAudit(db, {
        action: 'customer.registration_attempt_existing',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: {
          outcome: 'blacklisted',
          identifierHash: hashRegistrationIdentifier(body.email),
        },
        ts: ctx.now,
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
