/**
 * POST /api/internal/admin/profile/recovery-codes/regenerate
 *
 * Rotate the admin's backup-code batch without touching the TOTP
 * secret. Requires password + current TOTP so a stolen session plus
 * password cannot silently swap the codes out from under the real
 * owner.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { ADMIN_TOTP_TABLE, regenerateRecoveryCodes } from '@/lib/auth/totp-management';
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

const RegenerateBody = z.object({
  currentPassword: existingPasswordSchema,
  totpCode: totpCodeSchema,
});

export const POST = adminRoute({
  permission: 'profile.recovery_codes_regenerate',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'admin_recovery_codes_regenerate',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;

    const body = await parseBody(ctx.request, RegenerateBody);

    const enrollmentRow = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM admin_users WHERE id = ${ctx.user.id} LIMIT 1`,
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

    return withIdempotency(
      {
        ctx,
        endpoint: 'admin.profile.recovery-codes.regenerate',
        subject: { kind: 'admin', id: ctx.user.id },
        body,
      },
      async () => {
        const authConfig = getAuthConfig();
        const reauth = await reauthGate({
          db: ctx.db,
          subject: { kind: 'admin', id: ctx.user.id },
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
          table: ADMIN_TOTP_TABLE,
          userId: ctx.user.id,
          now: ctx.now,
          onMutate: async (tx) => {
            // Rotating the backup-code batch is a credential mutation
            //, if the rotation wasn't initiated by the real owner,
            // every parallel admin session this user didn't authorise
            // should be torn down. Current session kept alive so the
            // UI can surface the fresh codes.
            await tx.execute(
              sql`UPDATE sessions
                     SET revoked_at = ${ctx.now.toISOString()},
                         revoked_reason = 'recovery_codes_regenerated'
                   WHERE user_id = ${ctx.user.id}
                     AND user_kind = 'admin'
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'admin_user.recovery_codes_regenerated',
              subject: { kind: 'admin_user', id: ctx.user.id },
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
