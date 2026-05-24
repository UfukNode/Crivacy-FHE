/**
 * POST /api/internal/profile/recovery-codes/regenerate
 *
 * Issue a fresh batch of 2FA recovery codes without touching the TOTP
 * secret. Used when a user has spent codes or wants to invalidate a
 * printed copy that may have been exposed.
 *
 * Guards, composed through {@link reauthGate}:
 *   - Session-authenticated (`dashboardRoute`)
 *   - Per-IP rate limit (`firm_recovery_codes_regenerate`, 5/15min)
 *   - Password + TOTP reauth. Regenerating codes without a valid live
 *     factor would let a stolen session rotate recovery codes behind
 *     the real owner's back; we demand the current authenticator so
 *     that path is closed.
 *   - The caller must currently be TOTP-enrolled, regenerating codes
 *     on an account that has none is a user-error (409). Callers that
 *     want to bootstrap codes should use `/totp/replace` instead.
 *
 * On success the raw codes are returned exactly once. Only hashes
 * land in the DB; the server cannot recover them later.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { FIRM_TOTP_TABLE, regenerateRecoveryCodes } from '@/lib/auth/totp-management';
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

const RegenerateBody = z.object({
  currentPassword: existingPasswordSchema,
  totpCode: totpCodeSchema,
});

export const POST = dashboardRoute({
  permission: 'profile.recovery_codes_regenerate',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // --- 0. Per-IP rate limit ---
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'firm_recovery_codes_regenerate',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, RegenerateBody);

    // --- 2. Enrollment precheck. Regenerating recovery codes for an
    //        account that has no TOTP makes no sense, return 409 and
    //        steer the caller to the enroll flow.
    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM firm_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (enrollmentRow.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    if (enrolledAt === null || enrolledAt === undefined) {
      return ctx.errorJson(
        'conflict',
        'TOTP is not enrolled; enroll before regenerating recovery codes.',
        409,
      );
    }

    // --- 3. Idempotency-wrapped reauth + rotate. Crucial here
    //        because a double-submit would mint TWO fresh recovery-
    //        code batches, the user saw the first set, but their
    //        DB has the second set, so every saved code is now
    //        invalid. The HOF replays the first batch on retry.
    return withIdempotency(
      {
        ctx,
        endpoint: 'firm.profile.recovery-codes.regenerate',
        subject: { kind: 'firm', id: ctx.user.id },
        body,
      },
      async () => {
        const authConfig = getAuthConfig();
        const reauth = await reauthGate({
          db: ctx.db,
          subject: { kind: 'firm', id: ctx.user.id },
          password: body.currentPassword,
          factor: { type: 'totp', code: body.totpCode },
          now: ctx.now,
          authConfig,
        });
        if (reauth.status === 'failed') {
          const mapped = reauthFailureResponse(reauth.reason);
          return ctx.errorJson(mapped.code, mapped.message, mapped.status);
        }

        const result = await regenerateRecoveryCodes({
          db: ctx.db,
          table: FIRM_TOTP_TABLE,
          userId: ctx.user.id,
          now: ctx.now,
          onMutate: async (tx) => {
            // Rotating the backup-code batch is a credential mutation;
            // parallel firm sessions this user did not authorise get
            // torn down. Current session stays alive to surface the
            // freshly-minted codes.
            await tx.execute(
              sql`UPDATE sessions
                     SET revoked_at = ${ctx.now.toISOString()},
                         revoked_reason = 'recovery_codes_regenerated'
                   WHERE user_id = ${ctx.user.id}
                     AND user_kind = 'firm'
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'firm_user.recovery_codes_regenerated',
              subject: { kind: 'firm_user', id: ctx.user.id },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                reason: 'user_initiated',
              },
              now: ctx.now,
            });
          },
        });

        return ctx.json({ recoveryCodes: result.recoveryCodes });
      },
    );
  },
});
