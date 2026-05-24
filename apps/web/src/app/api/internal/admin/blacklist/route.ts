/**
 * GET /api/internal/admin/blacklist, list blacklisted entries with pagination
 *
 * Requires a valid admin session with at least 'admin' role.
 *
 * Query parameters:
 *   - `cursor`, ID of the last entry from the previous page (optional)
 *   - `limit`, page size (default 20, max 100)
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { listBlacklist, removeFromBlacklist } from '@/lib/fraud';
import { writeAudit } from '@/lib/audit/writer';
import { adminUserActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminRoute({
  permission: 'admin.blacklist.read',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    let limit = 20;
    if (limitParam !== null) {
      const parsed = parseInt(limitParam, 10);
      if (!Number.isNaN(parsed) && parsed >= 1) {
        limit = Math.min(parsed, 100);
      }
    }

    const entries = await listBlacklist(ctx.db, cursor, limit);

    return ctx.json({
      entries: entries.map((e) => ({
        id: e.id,
        emailHash: e.emailHash,
        documentHash: e.documentHash ?? null,
        // Sprint 6, `walletAddressHash` (wallet-only login users)
        // and `faceHash` (cascade-ban anchor) were dropped silently
        // pre-Sprint-6 even though both columns existed. Admin UI
        // / audit-search consumers need them to triage cascades.
        walletAddressHash: e.walletAddressHash ?? null,
        faceHash: e.faceHash ?? null,
        reason: e.reason,
        source: e.source,
        diditSessionId: e.diditSessionId ?? null,
        customerId: e.customerId ?? null,
        bannedBy: e.bannedBy ?? null,
        notes: e.notes ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      count: entries.length,
      cursor: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    });
  },
});

const BlacklistDeleteBody = z.object({
  id: z.string().uuid('id must be a valid UUID v4.'),
});

export const DELETE = adminRoute({
  permission: 'admin.blacklist.manage',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx) => {
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);
    const { id: blacklistId } = BlacklistDeleteBody.parse(rest);

    // BUG #58: password + TOTP reauth before blacklist remove
    // (manual escape-hatch; stolen-session destructive op).
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'admin', id: ctx.user.id },
      envelope: gate,
      now: ctx.now,
      authConfig: getAuthConfig(),
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    const removed = await removeFromBlacklist(ctx.db, blacklistId);
    if (!removed) {
      return ctx.errorJson('not_found', 'Blacklist entry not found.', 404);
    }

    // Audit
    const actor = adminUserActor({ id: ctx.user.id, label: ctx.user.email });
    const auditContext = buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    await writeAudit(ctx.db, {
      action: 'blacklist.removed',
      actor,
      target: noTarget(),
      context: auditContext,
      meta: { blacklistId },
      ts: ctx.now,
    });

    return ctx.json({ removed: true });
  },
});
