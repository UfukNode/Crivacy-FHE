/**
 * GET /api/internal/profile/totp/status
 *
 * Read-only status for the firm user's TOTP configuration. Drives
 * the dashboard security settings page, lets the UI decide whether
 * to render the "Enroll" / "Re-enroll" / "Disable" affordances and
 * the "Regenerate recovery codes" prompt, plus the remaining-codes
 * counter.
 *
 * Purely cosmetic data, the endpoint is not rate-limited beyond
 * the default auth checks because a session-authenticated GET that
 * reads only the caller's own state cannot be abused for lateral
 * enumeration or state-changing side effects.
 */

import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { countRemainingRecoveryCodes } from '@/lib/firm-auth/totp-management';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dashboardRoute({
  // Reading own TOTP status, `profile.totp_manage` is the self-service
  // TOTP permission; every firm_user preset holds it. Any user with
  // firm dashboard access reaches this endpoint.
  permission: 'profile.totp_manage',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const userRow = await ctx.db.execute<{
      totp_enrolled_at: string | null;
    }>(
      sql`SELECT totp_enrolled_at::text FROM firm_users WHERE id = ${ctx.user.id} LIMIT 1`,
    );
    const row = userRow.rows[0] as { totp_enrolled_at: string | null } | undefined;

    const firmSettings = await ctx.db.execute<{ totp_required: boolean }>(
      sql`SELECT totp_required FROM firm_settings WHERE firm_id = ${ctx.firm.id} LIMIT 1`,
    );
    const settingsRow = firmSettings.rows[0] as { totp_required: boolean } | undefined;

    const enrolled = row?.totp_enrolled_at !== null && row?.totp_enrolled_at !== undefined;
    const recoveryCodesRemaining = enrolled
      ? await countRemainingRecoveryCodes(ctx.db, ctx.user.id)
      : 0;

    return ctx.json({
      enrolled,
      enrolledAt: row?.totp_enrolled_at ?? null,
      recoveryCodesRemaining,
      /** Firm-level policy, UI uses this to hide the Disable button. */
      firmRequiresTotp: settingsRow?.totp_required ?? true,
    });
  },
});
