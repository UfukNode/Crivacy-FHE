/**
 * POST /api/internal/admin/customers/:id/unban, unban a customer
 *
 * Requires a valid admin session with 'superadmin' role.
 *
 * Body: `{ reason?: string }`
 *
 * Unbanning a customer:
 *   1. Sets customer status from 'banned' to 'suspended' (not 'active' —
 *      the customer must re-verify after an unban)
 *   2. Removes the customer's blacklist entry
 *   3. Writes an audit entry
 *
 * Note: the customer must still complete re-verification to reach 'active'
 * status. Unbanning only lifts the ban; it does not restore the previous
 * KYC level or credentials.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import {
  parseDestructiveEnvelope,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import * as schema from '@/lib/db/schema';
import { removeFromBlacklist } from '@/lib/fraud';
import { writeAuditBatch } from '@/lib/audit/writer';
import type { WriteAuditInput } from '@/lib/audit/writer';
import { adminUserActor } from '@/lib/audit/actors';
import { uuidTarget, noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { notifyCustomerStatusChange } from '@/lib/notification';
import { adminRoute } from '@/server/middleware';
import {
  findAdminSessionByJtiForMiddleware,
  findAdminUserByIdForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UnbanBody = z.object({
  reason: z.string().max(2048).optional(),
});

export const POST = adminRoute({
  // Matrix: Unban is Superadmin-only (irreversible in compliance
  // terms, once a ban is lifted, the prior record still exists).
  permission: 'admin.customer.unban',
  authConfig: getAuthConfig,
  sessionLookup: findAdminSessionByJtiForMiddleware,
  adminUserLookup: findAdminUserByIdForMiddleware,
  handler: async (ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: customerId } = await params;

    // --- 1. Validate UUID format ---
    if (!UUID_V4_REGEX.test(customerId)) {
      return ctx.errorJson('validation_error', 'Invalid customer ID format.', 400);
    }

    // --- 2. Parse body envelope ---
    const { rest, gate } = await parseDestructiveEnvelope(ctx.request);
    const body = UnbanBody.parse(rest);

    // --- 3. BUG #58: password + TOTP reauth before unban
    //         (Superadmin-tier action, blacklist remove). ---
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

    const reasonStr =
      body.reason !== undefined && body.reason.length > 0 ? body.reason : null;

    // --- 4. Fetch customer and validate state ---
    const customerRows = await ctx.db
      .select()
      .from(schema.customers)
      .where(
        and(
          eq(schema.customers.id, customerId),
          isNull(schema.customers.deletedAt),
        ),
      )
      .limit(1);

    const customer = customerRows[0];
    if (customer === undefined) {
      return ctx.errorJson('not_found', 'Customer not found.', 404);
    }

    if (customer.status !== 'banned') {
      return ctx.errorJson('conflict', 'Customer is not banned.', 409);
    }

    // --- 4. Set status to suspended ---
    const updated = await ctx.db
      .update(schema.customers)
      .set({
        status: 'suspended',
        updatedAt: ctx.now,
      })
      .where(eq(schema.customers.id, customerId))
      .returning();

    const updatedRow = updated[0];
    if (updatedRow === undefined) {
      return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
    }

    // --- 5. Remove blacklist entries for this customer ---
    const blacklistEntries = await ctx.db
      .select({ id: schema.customerBlacklist.id })
      .from(schema.customerBlacklist)
      .where(eq(schema.customerBlacklist.customerId, customerId));

    let blacklistEntriesRemoved = 0;
    for (const entry of blacklistEntries) {
      const removed = await removeFromBlacklist(ctx.db, entry.id);
      if (removed) {
        blacklistEntriesRemoved++;
      }
    }

    // --- 6. Audit ---
    const actor = adminUserActor({ id: ctx.user.id, label: ctx.user.email });
    const target = uuidTarget({ kind: 'customer', id: customerId });
    const auditContext = buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    const auditEntries: WriteAuditInput[] = [
      {
        action: 'customer.unbanned',
        actor,
        target,
        context: auditContext,
        meta: {
          previousStatus: 'banned',
          newStatus: 'suspended',
          blacklistEntriesRemoved,
          ...(reasonStr !== null ? { reason: reasonStr } : {}),
        },
        ts: ctx.now,
      },
    ];

    // Add blacklist.removed audit entry if entries were removed
    if (blacklistEntriesRemoved > 0) {
      auditEntries.push({
        action: 'blacklist.removed',
        actor,
        target: noTarget(),
        context: auditContext,
        meta: {
          customerId,
          entriesRemoved: blacklistEntriesRemoved,
          ...(reasonStr !== null ? { reason: reasonStr } : {}),
        },
        ts: ctx.now,
      });
    }

    await writeAuditBatch(ctx.db, auditEntries);

    // Notify customer, ban lifted but account is in suspended state (under review)
    await notifyCustomerStatusChange(ctx.db, {
      customerId,
      action: 'unbanned_review',
      reason: reasonStr ?? undefined,
    });

    return ctx.json({
      unbanned: true,
      customerId,
      newStatus: 'suspended',
      blacklistEntriesRemoved,
    });
  },
});
