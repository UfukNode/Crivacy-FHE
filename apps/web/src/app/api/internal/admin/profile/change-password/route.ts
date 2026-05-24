/**
 * POST /api/internal/admin/profile/change-password
 *
 * Change the admin user's password. Reauth contract: password + TOTP
 * (BUG #58 / Cat 38 follow-up). The TOTP layer protects the only
 * scenario rate-limit + lockout cannot, a session thief who already
 * has the password (phishing, password-reuse, infostealer); password-
 * only would let them rotate the legitimate user out without any
 * second-factor proof. HIBP check on the new password catches
 * publicly-leaked strings even when they meet the structural floor.
 *
 * On success every OTHER admin session for this user is revoked,
 * single-session enforcement for the session that just performed the
 * change. Also dispatches an out-of-band email so a real owner whose
 * password was rotated by a stolen-session attacker gets signalled
 * in their inbox.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { newPasswordSchema } from '@/lib/validation/auth';
import { adminRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChangePasswordBody = z.object({
  ...reauthEnvelopeShape,
  newPassword: newPasswordSchema,
});

export const POST = adminRoute({
  permission: 'profile.update',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'admin_change_password',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;

    const body = await parseBody(ctx.request, ChangePasswordBody);
    const authConfig = getAuthConfig();
    const now = ctx.now;
    const adminId = ctx.user.id;

    // Idempotency-wrapped. Key benefit for password change: a retry
    // after the first request rotated the hash would otherwise see
    // the new password as "wrong" (reauth fails against the just-
    // rotated hash) and 401. The HOF replays the original success
    // response instead.
    return withIdempotency(
      {
        ctx,
        endpoint: 'admin.profile.change-password',
        subject: { kind: 'admin', id: adminId },
        body,
      },
      async () => {
        const reauth = await requireTotpReauth({
          db: ctx.db,
          subject: { kind: 'admin', id: adminId },
          envelope: {
            currentPassword: body.currentPassword,
            totpCode: body.totpCode,
          },
          now,
          authConfig,
        });
        if (reauth.status === 'denied') {
          return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
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

        // State change + outbox emit in a single transaction. Before
        // the outbox migration the UPDATE ran first, then audit +
        // email dispatch ran inline post-commit, if either of those
        // threw, the state change had already landed but the trail
        // was silently incomplete. Co-locating the emit with the
        // UPDATE closes that gap: the worker picks up the row and
        // fans out to audit + email subscribers asynchronously; a
        // crash before the worker polls leaves the outbox row
        // pending, to be retried.
        //
        // Race guard (BUG #53 admin variant): `WHERE password_hash =
        // ${reauth.verifiedPasswordHash}` ensures two concurrent
        // change-password POSTs sharing the same correct currentPassword
        // can't both flip the hash. Whichever transaction lands the
        // UPDATE first wins; the loser's UPDATE returns 0 rows and we
        // unwind the transaction so neither audit nor session-revoke
        // observes a half-committed state.
        const RaceLostMarker = Symbol('admin-change-password-race-lost');
        try {
          await ctx.db.transaction(async (tx) => {
            const updateResult = await tx.execute(
              sql`UPDATE admin_users
                     SET password_hash = ${newHash},
                         password_changed_at = ${now.toISOString()},
                         updated_at = ${now.toISOString()}
                   WHERE id = ${adminId}
                     AND password_hash = ${reauth.verifiedPasswordHash}
                   RETURNING id`,
            );
            if (updateResult.rowCount === 0) {
              throw RaceLostMarker;
            }
            await tx.execute(
              sql`UPDATE sessions
                     SET revoked_at = ${now.toISOString()},
                         revoked_reason = 'password_changed'
                   WHERE user_id = ${adminId}
                     AND user_kind = 'admin'
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
            await emitSecurityEvent({
              db: tx,
              eventType: 'admin_user.password_changed',
              subject: { kind: 'admin_user', id: adminId },
              payload: {
                auditContext: {
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  requestId: ctx.requestId,
                },
                sessionId: ctx.session.sessionId,
                email: ctx.user.email,
                displayName: ctx.user.displayName,
                reason: 'changed',
                securityUrlPath: '/admin/settings/security',
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
