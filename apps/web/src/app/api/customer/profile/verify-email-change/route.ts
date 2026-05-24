/**
 * POST /api/customer/profile/verify-email-change
 *
 * Complete an email change by verifying the 6-digit code sent to the
 * new email address. Input: `{ token, code }` where `token` is the
 * JWT minted by `/change-email` and `code` is the verification digit
 * the user typed.
 *
 * Security contract (redesigned as part of the Phase 3 primitive
 * migration):
 *
 *   - The attempts counter + token burn now go through
 *     {@link verifyEmailCode}, which expresses both as atomic UPDATE
 *     statements. Prior to this migration, two concurrent submissions
 *     of a wrong code could both read `attempts: N` and both write
 *     `attempts: N+1`, letting an attacker burn many more tries than
 *     `MAX_CODE_ATTEMPTS` allowed (finding H2). The primitive's
 *     `attempts = attempts + 1` + `FOR UPDATE` subquery closes that.
 *
 *   - The email-taken re-check was a SELECT-then-UPDATE race: another
 *     customer could claim the target address between our read and
 *     our write, the DB's unique index would reject the UPDATE, and
 *     the uncaught 23505 bubbled as a 500 that leaked the collision
 *     to the caller (finding H3). The UPDATE now runs through
 *     {@link runOrCatchUnique}, which converts the 23505 on
 *     `customers_email_key` into a clean 409 without the 500.
 *
 *   - Per-IP rate limit (`customer_verify_email_change`, 20/15min)
 *     defences in depth over the per-token attempts counter for
 *     cases where a stolen-session attacker tries to burn through
 *     codes in parallel across many tokens.
 *
 * On success: `customers.email` + `email_verified_at` are updated and
 * a notification email goes to the OLD address so the real owner
 * sees the change out-of-band.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { safeJwtVerify } from '@/lib/auth/jwt';

import {
  MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
  maybeRateLimitResponse,
} from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  CUSTOMER_EMAIL_VERIFICATION_TABLE,
  verifyEmailCode,
} from '@/lib/auth/verify-email-code';
import { getDatabaseClient } from '@/lib/db/client';
import { runOrCatchUnique } from '@/lib/db/unique-violation';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';
import { getCustomerAuthConfig } from '@/lib/customer/config';

import { verificationCodeSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VerifyEmailChangeBody = z.object({
  token: z.string().min(1).max(4096),
  code: verificationCodeSchema,
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

    // --- 0. Per-IP rate limit ---
    const limited = await maybeRateLimitResponse(
      db,
      'customer_verify_email_change',
      ctx.ip,
      now,
    );
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, VerifyEmailChangeBody);

    // Idempotency-wrapped. Critical here: the atomic code-burn in
    // verifyEmailCode is one-shot, so a double-submit without HOF
    // would see `used` on the retry and fail with `code_invalid` —
    // even though the operation already succeeded. The HOF replays
    // the original `{ status: 'changed' }` 200 instead.
    return withIdempotency(
      {
        ctx,
        endpoint: 'customer.profile.verify-email-change',
        subject: { kind: 'customer', id: customerId },
        body,
      },
      async () => {
        // Verify JWT, carries target email + customerId.
        const secret = new TextEncoder().encode(authConfig.jwtSecret);
        let newEmail: string;
        try {
          const { payload } = await safeJwtVerify(body.token, secret);
          if (payload['purpose'] !== 'email_change') {
            return ctx.errorJson('invalid_token', 'Invalid email change token.', 400);
          }
          if (payload['customerId'] !== customerId) {
            return ctx.errorJson('invalid_token', 'Token does not match your session.', 400);
          }
          const claimed = payload['newEmail'];
          if (typeof claimed !== 'string') {
            return ctx.errorJson('invalid_token', 'Malformed email change token.', 400);
          }
          newEmail = claimed;
        } catch {
          return ctx.errorJson(
            'token_expired',
            'Email change request has expired. Please start again.',
            400,
          );
        }

        // Blacklist re-check.
        const emailHash = createHash('sha256').update(newEmail).digest('hex');
        const blacklisted = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
        );
        if (
          parseInt((blacklisted.rows[0] as { count: string } | undefined)?.count ?? '0', 10) > 0
        ) {
          return ctx.errorJson('email_blocked', 'This email address cannot be used.', 403);
        }

        // Atomic verify, hashes + burns in a single UPDATE.
        const verifyResult = await verifyEmailCode({
          db,
          table: CUSTOMER_EMAIL_VERIFICATION_TABLE,
          subjectId: customerId,
          submittedCode: body.code,
          maxAttempts: customerConfig.maxCodeAttempts,
          now,
        });

        switch (verifyResult.status) {
          case 'match':
            break;
          case 'expired':
            return ctx.errorJson(
              'code_expired',
              'Verification code has expired. Please request a new one.',
              400,
            );
          case 'used':
          case 'invalidated':
            return ctx.errorJson(
              'code_invalid',
              'Verification code is no longer valid. Please request a new one.',
              400,
            );
          case 'not_found':
            return ctx.errorJson(
              'no_pending_code',
              'No pending verification code found. Please request a new one.',
              400,
            );
          case 'exhausted':
            return ctx.errorJson(
              'code_max_attempts',
              'Too many wrong attempts. Please request a new code.',
              429,
              undefined,
              MAX_CODE_ATTEMPTS_RETRY_AFTER_SECONDS,
            );
          case 'mismatch':
            return ctx.errorJson('code_invalid', 'Invalid verification code.', 400);
        }

        // Commit the email change + emit the event inside one
        // transaction. Unique-index collision on the UPDATE (another
        // customer grabbed the same address between initiate and
        // verify) surfaces as a clean 409 via runOrCatchUnique.
        const oldEmail = ctx.customer.email;
        const displayName =
          ctx.customer.displayName ?? oldEmail?.split('@')[0] ?? 'User';
        // Explicit union so the narrow-on-assign inside the closure
        // below does not collapse the type to the initial literal.
        let writeStatus = 'ok' as 'ok' | 'violation';
        await db.transaction(async (tx) => {
          const result = await runOrCatchUnique(
            () =>
              tx.execute(
                sql`UPDATE customers
                       SET email = ${newEmail},
                           email_verified_at = ${now.toISOString()},
                           updated_at = ${now.toISOString()}
                     WHERE id = ${customerId}`,
              ),
            ['customers_email_key'],
          );
          if (result.status === 'violation') {
            writeStatus = 'violation';
            return;
          }
          // Email is the password-recovery anchor, rotating it is a
          // credential mutation, so parallel customer sessions this
          // user did not authorise must be torn down. Current session
          // stays alive so the UI can confirm the new email.
          await tx.execute(
            sql`UPDATE customer_sessions
                   SET revoked_at = ${now.toISOString()},
                       revoked_reason = 'email_changed'
                 WHERE customer_id = ${customerId}
                   AND revoked_at IS NULL
                   AND id != ${ctx.session.sessionId}`,
          );
          await emitSecurityEvent({
            db: tx,
            eventType: 'customer.email_changed',
            subject: { kind: 'customer', id: customerId },
            payload: {
              auditContext: {
                ip: ctx.ip,
                userAgent: ctx.userAgent,
                requestId: ctx.requestId,
              },
              oldEmail,
              newEmail,
              displayName,
            },
            now,
          });
        });
        if (writeStatus === 'violation') {
          return ctx.errorJson(
            'email_taken',
            'This email address is now in use by another account.',
            409,
          );
        }

        return ctx.json({ status: 'changed', message: 'Email address updated successfully.' });
      },
    );
  },
});
