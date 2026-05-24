/**
 * PATCH  /api/internal/firm/users/[id], change a teammate's role.
 * DELETE /api/internal/firm/users/[id], remove (lock) a teammate.
 *
 * Both endpoints are owner/admin-only (`minRole: 'admin'`); the
 * handlers then run the central role engine for deeper invariants
 * (cannot manage a teammate at or above your rank, owner-count
 * invariant, self-change lock).
 */

import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import {
  handleChangeFirmUserRole,
  handleRemoveFirmTeammate,
} from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return dashboardRoute({
    permission: 'firm.user.role_change',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: async (ctx) => {
      // Per-IP cap. Role changes are audit-visible and can escalate
      // privilege within the firm, gate against stolen-session spam.
      const limited = await maybeRateLimitResponse(
        ctx.db,
        'firm_users_role_change',
        ctx.ip,
        ctx.now,
      );
      if (limited) return limited;

      // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
      // role change is the firm-side privilege escalation primitive
      // (member→admin grants webhook.delete + api_key.revoke.any).
      // BUG #57+58 missed it; stolen-session admin/owner could
      // promote teammates without a second factor.
      const { rest, gate } = await parseDestructiveEnvelope(ctx.request);
      const reauth = await requireTotpReauth({
        db: ctx.db,
        subject: { kind: 'firm', id: ctx.user.id },
        envelope: gate,
        now: ctx.now,
        authConfig: getAuthConfig(),
      });
      if (reauth.status === 'denied') {
        return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
      }
      // Owner-target guard lives inside `handleChangeFirmUserRole` —
      // the handler already blocks Admin from demoting Owner and
      // enforces the last-owner invariant (Faz 14 hooks here).
      return handleChangeFirmUserRole(ctx, id, rest);
    },
  })(request);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return dashboardRoute({
    permission: 'firm.user.remove',
    authConfig: getAuthConfig,
    sessionLookup: findSessionByJtiForMiddleware,
    firmUserLookup: findFirmUserByIdForMiddleware,
    firmLookup: findFirmByIdForMiddleware,
    handler: async (ctx) => {
      const limited = await maybeRateLimitResponse(
        ctx.db,
        'firm_users_remove',
        ctx.ip,
        ctx.now,
      );
      if (limited) return limited;

      // Cat 38 destructive-reauth sweep follow-up (Page 7 closure):
      // teammate removal locks the row (lockedAt set + invite burned)
      //, combined with the multi-firm row resolver fix this is the
      // offboard primitive that must demand password+TOTP. Without
      // the gate a stolen owner/admin session could lock out every
      // other teammate, including the firm's other owner.
      const envelope = await parseBody(ctx.request, z.object(reauthEnvelopeShape));
      const reauth = await requireTotpReauth({
        db: ctx.db,
        subject: { kind: 'firm', id: ctx.user.id },
        envelope,
        now: ctx.now,
        authConfig: getAuthConfig(),
      });
      if (reauth.status === 'denied') {
        return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
      }
      return handleRemoveFirmTeammate(ctx, id);
    },
  })(request);
}
