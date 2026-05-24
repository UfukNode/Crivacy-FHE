/**
 * GET /api/internal/admin/profile/totp/status
 *
 * Read-only status for the admin's TOTP configuration. Drives the
 * admin security settings page, lets the UI decide between the
 * enroll / re-enroll / disable affordances and surfaces the remaining
 * recovery-code count.
 *
 * Purely cosmetic data; the endpoint is not rate-limited beyond the
 * default session auth because a session-authenticated GET that reads
 * only the caller's own state cannot be abused for lateral lookup.
 */

import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { ADMIN_TOTP_TABLE, countRemainingRecoveryCodes } from '@/lib/auth/totp-management';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const row = await ctx.db.execute<{ totp_enrolled_at: string | null }>(
      sql`SELECT totp_enrolled_at::text FROM admin_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const enrolledAt = (row.rows[0] as { totp_enrolled_at: string | null } | undefined)
      ?.totp_enrolled_at;
    const enrolled = enrolledAt !== null && enrolledAt !== undefined;

    const recoveryCodesRemaining = enrolled
      ? await countRemainingRecoveryCodes(ctx.db, ADMIN_TOTP_TABLE, ctx.user.id)
      : 0;

    return ctx.json({
      enrolled,
      enrolledAt: enrolledAt ?? null,
      recoveryCodesRemaining,
    });
  },
});
