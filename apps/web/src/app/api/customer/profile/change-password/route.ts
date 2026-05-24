/**
 * POST /api/customer/profile/change-password
 *
 * Change the customer's password. Requires the current password to be
 * verified before accepting the new one. The new password must be at
 * least 8 characters and have a strength score >= 2 (fair).
 *
 * Hashes the new password with Argon2id using the production cost
 * parameters from AuthConfig.
 *
 * Writes an audit entry: `customer.password_changed`.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { getDatabaseClient } from '@/lib/db/client';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';

import { existingPasswordSchema, newPasswordSchema } from '@/lib/validation/auth';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChangePasswordBody = z.object({
  currentPassword: existingPasswordSchema,
  newPassword: newPasswordSchema,
});
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;

    // --- 0. Per-IP rate limit. Defends against a stolen session
    //        cookie being used to brute-force `currentPassword`
    //        even though argon2 already costs ~100ms per verify.
    const limited = await maybeRateLimitResponse(db, 'customer_change_password', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, ChangePasswordBody);

    // --- 2. Idempotency-wrapped reauth + rotate + session revoke.
    //        Password change has a particularly nasty double-submit
    //        failure mode: first request rotates the hash; second
    //        request's `currentPassword` no longer matches the just-
    //        rotated hash → 401 `invalid_password` even though the
    //        caller's credentials are correct. The HOF replays the
    //        original 200 instead.
    const authConfig = getAuthConfig();
    return withIdempotency(
      {
        ctx,
        endpoint: 'customer.profile.change-password',
        subject: { kind: 'customer', id: customerId },
        body,
      },
      async () => {
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

        if (body.currentPassword === body.newPassword) {
          return ctx.errorJson(
            'validation_failed',
            'New password must be different from the current password.',
            400,
          );
        }

        await assertPasswordNotPwned(body.newPassword);

        const newHash = await hashPassword(body.newPassword, authConfig);

        // State change + outbox emit in a single transaction. See the
        // admin change-password route for the full rationale —
        // colocating the event emit with the UPDATE closes the
        // "state committed but audit/email missing" gap that used to
        // exist when those dispatches ran inline post-commit.
        //
        // Race guard (BUG #53): we add `WHERE password_hash = $verifiedHash`
        // to the customer UPDATE so two concurrent change-password POSTs
        // sharing the same correct currentPassword cannot both flip the
        // hash. The reauth step verified `currentPassword` against
        // `verifiedHash`; if a parallel request commits first, our
        // `WHERE password_hash = ${verifiedHash}` clause stops matching
        // and `rowCount === 0` signals the loss, we throw to roll back
        // the entire transaction and return a 401 so the caller knows
        // their snapshot of the password was overwritten.
        const RaceLostMarker = Symbol('change-password-race-lost');
        try {
          await db.transaction(async (tx) => {
            const updateResult = await tx.execute(
              sql`UPDATE customers
                 SET password_hash = ${newHash}, updated_at = ${now.toISOString()}
                 WHERE id = ${customerId}
                   AND password_hash = ${reauth.verifiedPasswordHash}
                 RETURNING id`,
            );
            if (updateResult.rowCount === 0) {
              throw RaceLostMarker;
            }
            await tx.execute(
              sql`UPDATE customer_sessions
                 SET revoked_at = ${now.toISOString()},
                     revoked_reason = 'password_changed'
                 WHERE customer_id = ${customerId}
                   AND revoked_at IS NULL
                   AND id != ${ctx.session.sessionId}`,
            );
            // F-XCC-P-RESET-LINK-NOT-INVALIDATED-AFTER-AUTH-CHANGE-001 —
            // NIST SP 800-63B §5.1.1.2: when an authenticator changes,
            // every recovery primitive bound to the previous credential
            // must be invalidated. A pending password-reset code that
            // was emailed minutes before this change-password call would
            // otherwise stay valid until its TTL expired, giving an
            // attacker who phished it a window to override the
            // legitimate rotation. Co-located with the session revoke
            // so the rotation, the session burn AND the reset-token
            // burn commit atomically (Pattern A-in-tx).
            await tx.execute(
              sql`UPDATE password_reset_tokens
                 SET invalidated_at = ${now.toISOString()}
                 WHERE customer_id = ${customerId}
                   AND used_at IS NULL
                   AND invalidated_at IS NULL`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'customer.password_changed',
              subject: { kind: 'customer', id: customerId },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                sessionId: ctx.session.sessionId,
                email: ctx.customer.email,
                displayName:
                  ctx.customer.displayName ??
                  ctx.customer.email?.split('@')[0] ??
                  'User',
                reason: 'changed',
                securityUrlPath: '/settings/security',
              },
              now,
            });
          });
        } catch (err) {
          if (err === RaceLostMarker) {
            return ctx.errorJson(
              'unauthenticated',
              'Current password is incorrect.',
              401,
            );
          }
          throw err;
        }

        return ctx.json({ changed: true });
      },
    );
  },
});
