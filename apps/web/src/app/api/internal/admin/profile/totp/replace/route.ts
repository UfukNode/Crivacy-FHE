/**
 * POST /api/internal/admin/profile/totp/replace
 *
 * Admin-side TOTP rotation / first-time enrollment. Mirror of the
 * firm endpoint (`/api/internal/profile/totp/replace`) built on the
 * same primitives: {@link reauthGate} for password + current-factor
 * proof, {@link replaceTotp} with {@link ADMIN_TOTP_TABLE} for the
 * atomic rotation.
 *
 * Already-enrolled admins must prove ownership of the current
 * authenticator (`currentTotpCode`) OR an unused recovery code before
 * the rotation lands, the same H1-class protection applied to firm
 * endpoints in Phase 3. First-time enrollment has no prior factor, so
 * password alone is accepted.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate, type ReauthFactor } from '@/lib/auth/reauth';
import { ADMIN_TOTP_TABLE, replaceTotp } from '@/lib/auth/totp-management';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ReplaceTotpBody = z.object({
  newSecret: z.string().min(16).max(256),
  newTotpCode: totpCodeSchema,
  currentPassword: existingPasswordSchema,
  currentTotpCode: totpCodeSchema.optional(),
  currentRecoveryCode: z.string().min(10).max(32).optional(),
});

export const POST = adminRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(ctx.db, 'admin_totp_replace', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(ctx.request, ReplaceTotpBody);

    // Enrollment state decides whether a current-factor proof is
    // required. An admin re-enrolling cannot skip the factor; a
    // first-time enroller has nothing to attest yet.
    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM admin_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (enrollmentRow.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    const alreadyEnrolled = enrolledAt !== null && enrolledAt !== undefined;

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

    // Idempotency-wrapped, same motivation as the firm endpoint:
    // a double-submit would mint two fresh recovery-code batches and
    // the user would be stranded with a copy of the first (now stale)
    // set.
    return withIdempotency(
      {
        ctx,
        endpoint: 'admin.profile.totp.replace',
        subject: { kind: 'admin', id: ctx.user.id },
        body,
      },
      async () => {
        const authConfig = getAuthConfig();
        const reauth = await reauthGate({
          db: ctx.db,
          subject: { kind: 'admin', id: ctx.user.id },
          password: body.currentPassword,
          factor,
          now: ctx.now,
          authConfig,
        });
        if (reauth.status === 'failed') {
          const mapped = reauthFailureResponse(reauth.reason);
          return ctx.errorJson(mapped.code, mapped.message, mapped.status);
        }

        const auditCtxPayload = {
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        };
        const result = await replaceTotp({
          db: ctx.db,
          authConfig,
          table: ADMIN_TOTP_TABLE,
          userId: ctx.user.id,
          newSecret: body.newSecret,
          newTotpCode: body.newTotpCode,
          now: ctx.now,
          onMutate: async (tx) => {
            // Rotating the authenticator is a credential mutation,
            // any parallel admin session this user didn't initiate
            // must be torn down. Current session kept alive so the
            // UI can show the fresh recovery codes without an
            // intermediate re-login.
            if (alreadyEnrolled) {
              await tx.execute(
                sql`UPDATE sessions
                       SET revoked_at = ${ctx.now.toISOString()},
                           revoked_reason = 'totp_replaced'
                     WHERE user_id = ${ctx.user.id}
                       AND user_kind = 'admin'
                       AND revoked_at IS NULL
                       AND id != ${ctx.session.sessionId}`,
              );
            }
            await emitSecurityEvent({
              db: tx,
              eventType: 'admin_user.totp_enabled',
              subject: { kind: 'admin_user', id: ctx.user.id },
              payload: {
                auditContext: auditCtxPayload,
                reason: alreadyEnrolled ? 'replaced' : 'enrolled',
                factor: factor.type,
              },
              now: ctx.now,
            });
            await emitSecurityEvent({
              db: tx,
              eventType: 'admin_user.recovery_codes_regenerated',
              subject: { kind: 'admin_user', id: ctx.user.id },
              payload: {
                auditContext: auditCtxPayload,
                reason: 'totp_replaced',
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
