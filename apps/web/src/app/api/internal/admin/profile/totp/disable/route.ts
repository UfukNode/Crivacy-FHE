/**
 * POST /api/internal/admin/profile/totp/disable
 *
 * Admin removes TOTP from their own account. Unlike firm users, no
 * firm-policy floor applies, admins self-regulate. The only gates
 * are the standard reauth contract (password + current factor) plus
 * the enrollment precheck that rejects a no-op disable.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate, type ReauthFactor } from '@/lib/auth/reauth';
import { ADMIN_TOTP_TABLE, disableTotp } from '@/lib/auth/totp-management';
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

const DisableTotpBody = z
  .object({
    currentPassword: existingPasswordSchema,
    totpCode: totpCodeSchema.optional(),
    recoveryCode: z.string().min(10).max(32).optional(),
  })
  .refine(
    (val) =>
      (val.totpCode !== undefined && val.totpCode.length > 0) ||
      (val.recoveryCode !== undefined && val.recoveryCode.length > 0),
    { message: 'Either `totpCode` or `recoveryCode` must be supplied.' },
  );

export const POST = adminRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(ctx.db, 'admin_totp_disable', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(ctx.request, DisableTotpBody);

    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM admin_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (enrollmentRow.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    if (enrolledAt === null || enrolledAt === undefined) {
      return ctx.errorJson('conflict', 'TOTP is not currently enrolled for this account.', 409);
    }

    let factor: ReauthFactor;
    if (body.totpCode !== undefined && body.totpCode.length > 0) {
      factor = { type: 'totp', code: body.totpCode };
    } else if (body.recoveryCode !== undefined && body.recoveryCode.length > 0) {
      factor = { type: 'recovery_code', code: body.recoveryCode };
    } else {
      return ctx.errorJson(
        'validation_failed',
        'Either TOTP code or recovery code is required.',
        400,
      );
    }

    return withIdempotency(
      {
        ctx,
        endpoint: 'admin.profile.totp.disable',
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

        await disableTotp({
          db: ctx.db,
          table: ADMIN_TOTP_TABLE,
          userId: ctx.user.id,
          now: ctx.now,
          onMutate: async (tx) => {
            // Revoke every OTHER admin session for this user, lowering
            // the account's factor count should tear down any parallel
            // browsers/devices the real owner doesn't control. Current
            // session stays alive so the UI can surface the new state
            // without forcing an immediate re-login.
            await tx.execute(
              sql`UPDATE sessions
                     SET revoked_at = ${ctx.now.toISOString()},
                         revoked_reason = 'totp_disabled'
                   WHERE user_id = ${ctx.user.id}
                     AND user_kind = 'admin'
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'admin_user.totp_disabled',
              subject: { kind: 'admin_user', id: ctx.user.id },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                reason: 'user_initiated',
                factor: factor.type,
              },
              now: ctx.now,
            });
          },
        });

        return ctx.json({ disabled: true });
      },
    );
  },
});
