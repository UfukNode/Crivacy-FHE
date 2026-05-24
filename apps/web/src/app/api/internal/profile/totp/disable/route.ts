/**
 * POST /api/internal/profile/totp/disable
 *
 * Remove TOTP from the firm user's account entirely. Used when a user
 * is stepping down from 2FA voluntarily.
 *
 * Guards, composed through {@link reauthGate}:
 *   - Session-authenticated (`dashboardRoute`)
 *   - Per-IP rate limit (`firm_totp_disable`, 5/15min)
 *   - Firm policy check, if `totp_required === true` on the firm
 *     settings row, the user cannot unilaterally drop below the floor;
 *     the endpoint refuses with 409 until an admin flips the setting.
 *   - Password + current-factor reauth: one of TOTP code OR recovery
 *     code must accompany the password. A stolen session + password
 *     is insufficient, the attacker must also own the factor they
 *     are removing, or the protection would be pointless.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate, type ReauthFactor } from '@/lib/auth/reauth';
import { FIRM_TOTP_TABLE, disableTotp } from '@/lib/auth/totp-management';
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
 * Either a current TOTP code OR a recovery code must be supplied; the
 * handler refuses the call when neither is present. The schema expresses
 * the optionality; the presence constraint is applied per-request
 * because it only matters once we know the caller reached here.
 */
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

export const POST = dashboardRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // --- 0. Per-IP rate limit ---
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_totp_disable', ctx.ip, ctx.now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, DisableTotpBody);

    // --- 2. Firm-level policy gate. If the firm mandates TOTP the
    //        user cannot unilaterally remove it, an admin must flip
    //        the firm setting first.
    const firmSettings = await ctx.db.execute<{ totp_required: boolean }>(
      sql`SELECT totp_required FROM firm_settings WHERE firm_id = ${ctx.firm.id} LIMIT 1`,
    );
    const settingsRow = firmSettings.rows[0] as { totp_required: boolean } | undefined;
    if (settingsRow?.totp_required === true) {
      return ctx.errorJson(
        'conflict',
        'Your firm requires TOTP for all members. Ask your administrator to change the firm policy before disabling.',
        409,
      );
    }

    // --- 3. Enrollment precheck. A user who has never enrolled cannot
    //        disable, return 409 rather than silently no-op so the UI
    //        surfaces the right affordance.
    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM firm_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (enrollmentRow.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    if (enrolledAt === null || enrolledAt === undefined) {
      return ctx.errorJson('conflict', 'TOTP is not currently enrolled for this account.', 409);
    }

    // --- 4. Build factor for reauth. The Zod refinement ensures at
    //        least one of totp/recovery is populated; TOTP wins when
    //        both are provided so the user can fall back to recovery
    //        only when they explicitly omit the authenticator field.
    let factor: ReauthFactor;
    if (body.totpCode !== undefined && body.totpCode.length > 0) {
      factor = { type: 'totp', code: body.totpCode };
    } else if (body.recoveryCode !== undefined && body.recoveryCode.length > 0) {
      factor = { type: 'recovery_code', code: body.recoveryCode };
    } else {
      // Defensive, the refine() above should have caught this.
      return ctx.errorJson(
        'validation_failed',
        'Either TOTP code or recovery code is required.',
        400,
      );
    }

    // --- 5. Idempotency-wrapped reauth + wipe. Disabling is already
    //        idempotent at the state level (row columns become NULL;
    //        re-running would be a no-op), but the audit emit is not,
    //        without idempotency a double-submit would write two
    //        `totp_disabled` audit rows. The HOF replays the cached
    //        response instead so the audit trail stays accurate.
    return withIdempotency(
      {
        ctx,
        endpoint: 'firm.profile.totp.disable',
        subject: { kind: 'firm', id: ctx.user.id },
        body,
      },
      async () => {
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

        await disableTotp({
          db: ctx.db,
          table: FIRM_TOTP_TABLE,
          userId: ctx.user.id,
          now: ctx.now,
          onMutate: async (tx) => {
            // Revoke every OTHER firm session for this user, dropping
            // a factor should tear down parallel browsers/devices that
            // the real owner doesn't control. Current session stays
            // alive so the UI can surface the new state.
            await tx.execute(
              sql`UPDATE sessions
                     SET revoked_at = ${ctx.now.toISOString()},
                         revoked_reason = 'totp_disabled'
                   WHERE user_id = ${ctx.user.id}
                     AND user_kind = 'firm'
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'firm_user.totp_disabled',
              subject: { kind: 'firm_user', id: ctx.user.id },
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
