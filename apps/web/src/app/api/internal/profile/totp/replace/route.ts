/**
 * POST /api/internal/profile/totp/replace
 *
 * Rotate the firm user's TOTP secret in place and issue a fresh
 * batch of recovery codes. Used from the dashboard security settings
 * screen when a user reinstalls their authenticator app, wants to
 * move to a different device, or is enrolling for the first time on
 * an invite-only account that was seeded without TOTP.
 *
 * Guards, composed through the {@link reauthGate} primitive so every
 * sensitive self-service flow agrees on the same surface:
 *
 *   - Session-authenticated (`dashboardRoute`)
 *   - Per-IP rate limit (`firm_totp_replace`, 5/15min)
 *   - Password reauth via reauthGate (fresh hash fetch, a stolen
 *     session cookie alone cannot satisfy this gate)
 *   - **Current-factor proof when already enrolled**. A user who is
 *     re-enrolling must also prove ownership of the CURRENT authenticator
 *     (`currentTotpCode`) OR a valid unused recovery code. Previously
 *     this endpoint accepted password-only reauth, so a compromised
 *     session + leaked password could silently swap the legitimate
 *     user's authenticator for an attacker-controlled one and lock
 *     them out. The factor requirement closes that gap (finding H1).
 *
 *   - First-time enrollment skips the current-factor step: `totp_enrolled_at IS NULL`
 *     means the user has no prior factor to prove, so password-only
 *     reauth is sufficient. Once TOTP is live for this account, every
 *     subsequent replace demands both.
 *
 * The submitted `newTotpCode` is verified against `newSecret` BEFORE
 * any DB write, so a mistyped code never leaves the user in a half-
 * rotated state.
 *
 * On success the raw recovery codes are returned exactly once. They
 * are hashed in the DB; the server cannot recover them later.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate, type ReauthFactor } from '@/lib/auth/reauth';
import { FIRM_TOTP_TABLE, replaceTotp } from '@/lib/auth/totp-management';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Request body. Exactly one of `currentTotpCode` / `currentRecoveryCode`
 * is required when the caller is already enrolled (validated against
 * the DB after parse); neither is required for first-time enrollment.
 * We deliberately do NOT encode the "one of the two" constraint in the
 * Zod schema itself, the branching depends on the DB state, which is
 * only available inside the handler.
 */
const ReplaceTotpBody = z.object({
  /** Base32 TOTP secret from the `/auth/totp/setup` step. */
  newSecret: z.string().min(16).max(256),
  /** 6-digit code produced by the freshly-configured authenticator. */
  newTotpCode: totpCodeSchema,
  /** Password reauth, proof the session belongs to the real user. */
  currentPassword: existingPasswordSchema,
  /** Current authenticator code (required for re-enrollment). */
  currentTotpCode: totpCodeSchema.optional(),
  /** Recovery code to use as the factor when authenticator is lost. */
  currentRecoveryCode: z.string().min(10).max(32).optional(),
});

export const POST = dashboardRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // --- 0. Per-IP rate limit ---
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_totp_replace', ctx.ip, ctx.now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, ReplaceTotpBody);

    // --- 2. Look up current enrollment state. The decision on whether
    //        a factor proof is required lives in the DB, not in the
    //        request body, a client cannot talk its way into a
    //        factor-less path by omitting the field.
    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM firm_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (enrollmentRow.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    const alreadyEnrolled = enrolledAt !== null && enrolledAt !== undefined;

    // --- 3. Decide which factor to demand through the reauth gate.
    //        Already-enrolled users must prove ownership of the
    //        CURRENT authenticator or a valid recovery code; first-
    //        time enrollees have no prior factor, so password alone
    //        is accepted.
    let factor: ReauthFactor;
    if (alreadyEnrolled) {
      if (body.currentTotpCode !== undefined && body.currentTotpCode.length > 0) {
        factor = { type: 'totp', code: body.currentTotpCode };
      } else if (body.currentRecoveryCode !== undefined && body.currentRecoveryCode.length > 0) {
        factor = { type: 'recovery_code', code: body.currentRecoveryCode };
      } else {
        return ctx.errorJson(
          'totp_required',
          'Current authenticator code or recovery code is required to replace the authenticator.',
          401,
        );
      }
    } else {
      factor = { type: 'none' };
    }

    // --- 4. Idempotency-wrapped main flow. A retried click (double-
    //        submit, flaky network) that carries the same
    //        Idempotency-Key header replays the cached `recoveryCodes`
    //        response instead of re-issuing a fresh batch, without
    //        this, the second request would see the secret already
    //        rotated and either fail or produce a different set of
    //        codes, desyncing the user from the download they saw.
    return withIdempotency(
      {
        ctx,
        endpoint: 'firm.profile.totp.replace',
        subject: { kind: 'firm', id: ctx.user.id },
        body,
      },
      async () => {
        // --- 4a. Reauth ---
        const authConfig = getAuthConfig();
        const reauth = await reauthGate({
          db: ctx.db,
          subject: { kind: 'firm', id: ctx.user.id },
          password: body.currentPassword,
          factor,
          now: ctx.now,
          authConfig,
        });
        if (reauth.status === 'failed') {
          const mapped = reauthFailureResponse(reauth.reason);
          return ctx.errorJson(mapped.code, mapped.message, mapped.status);
        }

        // --- 4b. Rotate secret + recovery codes + emit two security
        //        events, all inside the same transaction via the
        //        `onMutate` hook so the audit trail stays in lockstep
        //        with the rotation. `replaceTotp` throws
        //        `invalid_totp_code` if `newTotpCode` does not verify
        //        against `newSecret`; the error mapper surfaces that
        //        as 401 `totp_invalid` and nothing is written.
        const auditCtxPayload = {
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        };
        const result = await replaceTotp({
          db: ctx.db,
          authConfig,
          table: FIRM_TOTP_TABLE,
          userId: ctx.user.id,
          newSecret: body.newSecret,
          newTotpCode: body.newTotpCode,
          now: ctx.now,
          onMutate: async (tx) => {
            // Rotating the authenticator is a credential mutation,
            // every other firm session for this user gets torn down
            // so a parallel attacker session loses access. First-time
            // enrollment skips the revoke (no prior parallel auth
            // surface to worry about). Current session stays alive
            // to surface the freshly-minted recovery codes.
            if (alreadyEnrolled) {
              await tx.execute(
                sql`UPDATE sessions
                       SET revoked_at = ${ctx.now.toISOString()},
                           revoked_reason = 'totp_replaced'
                     WHERE user_id = ${ctx.user.id}
                       AND user_kind = 'firm'
                       AND revoked_at IS NULL
                       AND id != ${ctx.session.sessionId}`,
              );
            }
            await emitSecurityEvent({
              db: tx,
              eventType: 'firm_user.totp_enabled',
              subject: { kind: 'firm_user', id: ctx.user.id },
              payload: {
                auditContext: auditCtxPayload,
                reason: alreadyEnrolled ? 'replaced' : 'enrolled',
                factor: factor.type,
              },
              now: ctx.now,
            });
            await emitSecurityEvent({
              db: tx,
              eventType: 'firm_user.recovery_codes_regenerated',
              subject: { kind: 'firm_user', id: ctx.user.id },
              payload: {
                auditContext: auditCtxPayload,
                reason: 'totp_replaced',
              },
              now: ctx.now,
            });
          },
        });

        // --- 4c. Return the raw recovery codes exactly once. ---
        return ctx.json({ recoveryCodes: result.recoveryCodes });
      },
    );
  },
});
