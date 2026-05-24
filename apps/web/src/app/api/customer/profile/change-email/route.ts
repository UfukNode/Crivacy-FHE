/**
 * POST /api/customer/profile/change-email
 *
 * Initiate an email change. Sends a 6-digit verification code to the NEW
 * email address. Returns a signed JWT that must be sent back to the
 * verify-email-change endpoint together with the code.
 *
 * Guards:
 * - Customer must be logged in
 * - Customer must already have an email (use add-email for null→new)
 * - New email must not be the same as current
 * - New email must not be taken by another customer
 * - New email must not be blacklisted
 * - Rate limited (max codes per window)
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';
import { CUSTOMER_EMAIL_VERIFICATION_TABLE } from '@/lib/auth/verify-email-code';
import { getDatabaseClient } from '@/lib/db/client';
import { getAppUrl } from '@/lib/env/app-url';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';
import { getCustomerAuthConfig } from '@/lib/customer/config';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { emailChangeAttemptedEmail, emailChangeVerificationEmail } from '@/lib/email/templates';
import { emailSchema, existingPasswordSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// AUD-X-AUTHZ-CHANGE-EMAIL-001 fix (BUG #42): change-email is the
// canonical account-takeover primitive, flipping the login email to
// an attacker-controlled address lets them password-reset and lock the
// real owner out. The session cookie alone is NOT enough; require the
// caller to reprove the password before we issue any verification code,
// matching the gate already on `set-password` and `add-email`.
const ChangeEmailBody = z.object({
  newEmail: emailSchema,
  currentPassword: existingPasswordSchema,
});

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;
    const authConfig = getAuthConfig();
    const customerConfig = getCustomerAuthConfig();

    // --- 0. Per-IP rate limit. Protects against a stolen session
    //        probing the enumeration branch (email-owned-by-another
    //        customer → notification) or spamming verification codes.
    const limited = await maybeRateLimitResponse(db, 'customer_change_email', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, ChangeEmailBody);
    const newEmailLower = body.newEmail.toLowerCase().trim();

    // Idempotency-wrapped, the HOF protects against a double-
    // submit minting a second verification code (which would
    // invalidate the first) and a second audit+email. A retry with
    // the same Idempotency-Key replays the cached `{ token, message }`
    // response so the frontend can continue the flow with the
    // same JWT.
    return withIdempotency(
      {
        ctx,
        endpoint: 'customer.profile.change-email',
        subject: { kind: 'customer', id: customerId },
        body,
      },
      async () => {
        // Must already have an email (use add-email for null→new).
        if (ctx.customer.email === null) {
          return ctx.errorJson(
            'no_current_email',
            'No email set. Use Add Email instead.',
            409,
          );
        }

        // BUG #42 fix: password reauth gate. Runs before the same-email,
        // taken, and blacklisted branches so a stolen-cookie attacker
        // gets the same `wrong_password` 401 regardless of whether their
        // target address probes a real customer, the enumeration
        // protection downstream is only meaningful AFTER the password
        // gate is satisfied.
        const reauth = await reauthGate({
          db,
          subject: { kind: 'customer', id: customerId },
          password: body.currentPassword,
          factor: { type: 'none' },
          now,
          authConfig,
        });
        if (reauth.status === 'failed') {
          const mapped = reauthFailureResponse(reauth.reason);
          return ctx.errorJson(mapped.code, mapped.message, mapped.status);
        }

        // New email must differ from current.
        if (newEmailLower === ctx.customer.email.toLowerCase()) {
          return ctx.errorJson(
            'same_email',
            'New email is the same as your current email.',
            400,
          );
        }

        // Probe the target email, but do NOT gate the response on
        // the result, returning distinct errors for taken /
        // blacklisted would turn this authenticated endpoint into
        // a single-request enumeration oracle. Uniform response
        // shape across all three branches.
        const existing = await db.execute<{ id: string }>(
          sql`SELECT id FROM customers
           WHERE lower(email) = ${newEmailLower} AND deleted_at IS NULL AND id != ${customerId}
           LIMIT 1`,
        );
        const takenByCustomer = existing.rows[0] as { id: string } | undefined;

        const emailHash = createHash('sha256').update(newEmailLower).digest('hex');
        const blacklisted = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
        );
        const isBlacklisted =
          parseInt((blacklisted.rows[0] as { count: string } | undefined)?.count ?? '0', 10) > 0;

        // Per-user rate limit on token count in window.
        const windowMs = customerConfig.codeRateLimitWindowMinutes * 60 * 1000;
        const rateLimitWindow = new Date(now.getTime() - windowMs);
        const recentTokens = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count
           FROM email_verification_tokens
           WHERE customer_id = ${customerId}
             AND created_at > ${rateLimitWindow.toISOString()}`,
        );
        const recentCount = parseInt(
          (recentTokens.rows[0] as { count: string } | undefined)?.count ?? '0',
          10,
        );
        if (recentCount >= customerConfig.maxCodesPerWindow) {
          return ctx.errorJson(
            'rate_limited',
            'Too many requests. Please wait before trying again.',
            429,
          );
        }

        const shouldIssueRealCode = takenByCustomer === undefined && !isBlacklisted;

        if (shouldIssueRealCode) {
          // Atomic invalidate + issue via the shared primitive.
          const issued = await issueShortLivedToken({
            db,
            table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
            subjectId: customerId,
            ttlSeconds: customerConfig.verificationCodeTtlSeconds,
            now,
          });

          const emailContent = emailChangeVerificationEmail({
            displayName: ctx.customer.displayName ?? newEmailLower.split('@')[0] ?? 'User',
            code: issued.rawCode,
            newEmail: newEmailLower,
            expiresInMinutes: Math.round(customerConfig.verificationCodeTtlSeconds / 60),
          });
          await enqueueEmailFromRoute(db, {
            to: newEmailLower,
            content: emailContent,
            emailType: 'verification',
            userId: customerId,
          });
        } else if (takenByCustomer !== undefined) {
          // Notify the real owner of the target address out-of-band.
          const appUrl = getAppUrl();
          const notification = emailChangeAttemptedEmail({
            displayName: newEmailLower.split('@')[0] ?? 'there',
            loginUrl: `${appUrl}/login`,
          });
          await enqueueEmailFromRoute(db, {
            to: newEmailLower,
            content: notification,
            emailType: 'notification',
            userId: takenByCustomer.id,
          });
        }
        // isBlacklisted-only: silent drop.

        // Sign the uniform JWT, verify endpoint still requires a
        // matching DB token row, so JWTs issued on taken/blacklisted
        // branches cannot complete the flow.
        const secret = new TextEncoder().encode(authConfig.jwtSecret);
        const token = await new SignJWT({
          purpose: 'email_change',
          customerId,
          newEmail: newEmailLower,
        })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime(`${customerConfig.verificationCodeTtlSeconds}s`)
          .sign(secret);

        const auditCtx = buildAuditContext({
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        });
        await writeAudit(db, {
          action: 'customer.email_change_initiated',
          actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
          target: noTarget(),
          context: auditCtx,
          meta: {
            oldEmail: ctx.customer.email,
            newEmail: newEmailLower,
            outcome: shouldIssueRealCode
              ? 'code_sent'
              : takenByCustomer !== undefined
                ? 'target_taken_notified'
                : 'target_blacklisted_silent',
          },
          ts: now,
        });

        return ctx.json({ token, message: 'Verification code sent to your new email address.' });
      },
    );
  },
});
