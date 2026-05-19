/**
 * Admin firms handlers — list, create, update, soft-delete firms.
 *
 * @module
 */

import { adminUserActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import type { CrivacyDatabase } from '@/lib/db/client';
import { enqueueEmailFromRoute } from '@/lib/email';
import { firmUserInviteEmail } from '@/lib/email/templates';
import { getAppUrl } from '@/lib/env/app-url';

import type { AdminContext } from '../context';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NextResponse } from 'next/server';
import * as schema from '@/lib/db/schema';
import type {
  AdminFirmListItem,
  FirmCreationWithOwnerResult,
} from '../repositories/admin';
import { FIRM_INVITE_TTL_HOURS } from '../repositories/admin';
import { uuidSchema } from '@/lib/validation/common';

/* ---------- Types ---------- */

export interface AdminFirmsDeps {
  readonly listFirms: (
    db: CrivacyDatabase,
    opts?: {
      readonly includeDeleted?: boolean | undefined;
      readonly tier?: string | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ) => Promise<{ firms: readonly AdminFirmListItem[]; total: number }>;
  readonly createFirm: (
    db: CrivacyDatabase,
    input: {
      readonly name: string;
      readonly slug: string;
      readonly tier: string;
      readonly contactEmail: string;
      readonly countryCode?: string | undefined;
      readonly ownerEmail: string;
      readonly invitedByAdminId: string;
      readonly now: Date;
    },
  ) => Promise<FirmCreationWithOwnerResult>;
  readonly updateFirm: (
    db: CrivacyDatabase,
    firmId: string,
    updates: {
      readonly name?: string | undefined;
      readonly tier?: string | undefined;
      readonly contactEmail?: string | undefined;
      readonly countryCode?: string | undefined;
      readonly notes?: string | undefined;
    },
  ) => Promise<AdminFirmListItem | null>;
  readonly softDeleteFirm: (db: CrivacyDatabase, firmId: string, now: Date) => Promise<void>;
  readonly restoreFirm: (db: CrivacyDatabase, firmId: string) => Promise<void>;
  readonly getFirm: (db: CrivacyDatabase, firmId: string) => Promise<AdminFirmListItem | null>;
}

/* ---------- List ---------- */

export interface ListFirmsInput {
  readonly includeDeleted?: boolean | undefined;
  readonly tier?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ListFirmsResult {
  readonly firms: readonly AdminFirmListItem[];
  readonly total: number;
}

export async function handleListFirms(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  input: ListFirmsInput,
): Promise<ListFirmsResult> {
  return deps.listFirms(ctx.db, input);
}

/* ---------- Get ---------- */

export async function handleGetFirm(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  firmId: string,
): Promise<AdminFirmListItem | null> {
  return deps.getFirm(ctx.db, firmId);
}

/* ---------- Create ---------- */

export interface CreateFirmInput {
  readonly name: string;
  readonly slug: string;
  readonly tier: string;
  readonly contactEmail: string;
  readonly countryCode?: string | undefined;
  /**
   * Dashboard-owner email for the initial firm_user. The handler
   * creates the row with `password_hash = NULL`, generates a
   * single-use invite token, and emails the recipient a magic-link
   * to set their password + enable TOTP.
   */
  readonly ownerEmail: string;
}

export interface CreateFirmResult {
  readonly id: string;
  readonly firmUserId: string;
  readonly inviteExpiresAt: string;
}

/**
 * Full admin "create firm" flow — the persistence TX lives in the
 * repository; this handler wraps it with audit writes and the
 * post-commit welcome email so the dispatcher failure surface stays
 * out of the creation transaction.
 */
export async function handleCreateFirm(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  input: CreateFirmInput,
): Promise<CreateFirmResult> {
  const now = ctx.now;

  const creation = await deps.createFirm(ctx.db, {
    name: input.name,
    slug: input.slug,
    tier: input.tier,
    contactEmail: input.contactEmail,
    ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
    ownerEmail: input.ownerEmail,
    invitedByAdminId: ctx.user.id,
    now,
  });

  // --- Audit: firm creation + owner invitation ---
  const actor = adminUserActor({ id: ctx.user.id, label: ctx.user.email });
  const auditContext = buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  await writeAudit(ctx.db, {
    action: 'firm.created',
    actor,
    target: uuidTarget({ kind: 'firm', id: creation.firmId, ref: input.slug }),
    context: auditContext,
    meta: {
      name: input.name,
      slug: input.slug,
      tier: input.tier,
      contactEmail: input.contactEmail,
    },
    ts: now,
  });
  await writeAudit(ctx.db, {
    action: 'firm.user_invited',
    actor,
    target: uuidTarget({ kind: 'firm_user', id: creation.firmUserId }),
    context: auditContext,
    meta: {
      firmId: creation.firmId,
      ownerEmail: input.ownerEmail,
      role: 'owner',
      expiresAt: creation.expiresAt.toISOString(),
    },
    ts: now,
  });

  // --- Post-commit: send the invite email with the raw token. A
  // dispatcher failure MUST NOT roll back the firm creation; the
  // admin can resend the invite via a dedicated endpoint later. ---
  const appUrl = getAppUrl();
  // Fragment delivery (`#token=…`) keeps the token out of Referer
  // headers, server access logs, and CDN/proxy traces — URL fragments
  // never travel over the wire. Only the client-side React bundle
  // reads `window.location.hash` to POST it to /validate.
  const acceptUrl = `${appUrl}/dashboard/accept-invite#token=${encodeURIComponent(
    creation.inviteToken,
  )}`;
  await enqueueEmailFromRoute(ctx.db, {
    to: input.ownerEmail,
    content: firmUserInviteEmail({
      firmName: input.name,
      recipientEmail: input.ownerEmail,
      acceptUrl,
      expiresInHours: FIRM_INVITE_TTL_HOURS,
    }),
    emailType: 'welcome',
    userId: creation.firmUserId,
    metadata: {
      firmId: creation.firmId,
      kind: 'firm_user_invite',
    },
  });

  return {
    id: creation.firmId,
    firmUserId: creation.firmUserId,
    inviteExpiresAt: creation.expiresAt.toISOString(),
  };
}

/* ---------- Admin firm detail (drill-down) ---------- */

export async function handleGetAdminFirmDetail(
  ctx: AdminContext,
  firmId: string,
): Promise<NextResponse> {
  const { db } = ctx;

  if (!uuidSchema.safeParse(firmId).success) {
    return ctx.errorJson('validation_error', 'Invalid firm ID format.', 400);
  }

  const firmRows = await db
    .select()
    .from(schema.firms)
    .where(eq(schema.firms.id, firmId))
    .limit(1);
  const firm = firmRows[0];
  if (firm === undefined) {
    return ctx.errorJson('not_found', 'Firm not found.', 404);
  }

  // --- Team members ---
  const users = await db
    .select({
      id: schema.firmUsers.id,
      email: schema.firmUsers.email,
      role: schema.firmUsers.role,
      invitedAt: schema.firmUsers.invitedAt,
      acceptedAt: schema.firmUsers.acceptedAt,
      lastLoginAt: schema.firmUsers.lastLoginAt,
      lockedAt: schema.firmUsers.lockedAt,
      createdAt: schema.firmUsers.createdAt,
    })
    .from(schema.firmUsers)
    .where(eq(schema.firmUsers.firmId, firmId))
    .orderBy(schema.firmUsers.createdAt);

  // --- API keys (metadata only — hash + secret never returned) ---
  const apiKeys = await db
    .select({
      id: schema.apiKeys.id,
      prefix: schema.apiKeys.prefix,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      mode: schema.apiKeys.mode,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      lastUsedIp: schema.apiKeys.lastUsedIp,
      revokedAt: schema.apiKeys.revokedAt,
      revokedReason: schema.apiKeys.revokedReason,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.firmId, firmId))
    .orderBy(desc(schema.apiKeys.createdAt));

  // --- Webhook endpoints + health summary.
  // Schema uses `disabled_at` (nullable) rather than a boolean
  // `is_active`; `events` is the subscribed-types array.
  // Delivery status text 'delivered' indicates success.
  const webhookEndpoints = await db
    .select({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      label: schema.webhookEndpoints.label,
      disabledAt: schema.webhookEndpoints.disabledAt,
      events: schema.webhookEndpoints.events,
      createdAt: schema.webhookEndpoints.createdAt,
    })
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.firmId, firmId));

  let webhookHealth: {
    readonly deliveries24h: number;
    readonly failures24h: number;
    readonly successRate: number | null;
  } = { deliveries24h: 0, failures24h: 0, successRate: null };

  if (webhookEndpoints.length > 0) {
    const endpointIds = webhookEndpoints.map((w) => w.id);
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    const [totalRow] = await db
      .select({ value: count() })
      .from(schema.webhookDeliveries)
      .where(
        and(
          inArray(schema.webhookDeliveries.endpointId, endpointIds),
          sql`${schema.webhookDeliveries.createdAt} > ${since}`,
        ),
      );
    const [failRow] = await db
      .select({ value: count() })
      .from(schema.webhookDeliveries)
      .where(
        and(
          inArray(schema.webhookDeliveries.endpointId, endpointIds),
          sql`${schema.webhookDeliveries.createdAt} > ${since}`,
          sql`${schema.webhookDeliveries.status} != 'delivered'`,
        ),
      );
    const total = totalRow?.value ?? 0;
    const fails = failRow?.value ?? 0;
    webhookHealth = {
      deliveries24h: total,
      failures24h: fails,
      successRate: total > 0 ? (total - fails) / total : null,
    };
  }

  // --- Ticket summary ---
  const ticketCounts = await db
    .select({
      status: schema.tickets.status,
      value: count(),
    })
    .from(schema.tickets)
    .where(eq(schema.tickets.firmId, firmId))
    .groupBy(schema.tickets.status);

  const tickets: Record<string, number> = {
    open: 0,
    in_progress: 0,
    waiting_customer: 0,
    resolved: 0,
    closed: 0,
    total: 0,
  };
  for (const row of ticketCounts) {
    tickets[row.status] = row.value;
    tickets['total'] = (tickets['total'] ?? 0) + row.value;
  }

  // AUD-X-THREAT-002 fix: admin read of firm internals (contact
  // email, billing email, team roster, API keys, webhook URLs,
  // ticket stats) is an insider-trail requirement. `admin_user.firm_viewed`
  // audit row leaves a trail per successful GET; meta stays empty
  // because the target firm id + request context is enough.
  await writeAudit(db, {
    action: 'admin_user.firm_viewed',
    actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'firm', id: firmId }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {},
    ts: ctx.now,
  });

  return ctx.json({
    firm: {
      id: firm.id,
      name: firm.name,
      slug: firm.slug,
      tier: firm.tier,
      contactEmail: firm.contactEmail,
      billingEmail: firm.billingEmail,
      countryCode: firm.countryCode,
      supportUrl: firm.supportUrl,
      deletedAt: firm.deletedAt !== null ? firm.deletedAt.toISOString() : null,
      createdAt: firm.createdAt.toISOString(),
      updatedAt: firm.updatedAt.toISOString(),
    },
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      invitedAt: u.invitedAt !== null ? u.invitedAt.toISOString() : null,
      acceptedAt: u.acceptedAt !== null ? u.acceptedAt.toISOString() : null,
      lastLoginAt: u.lastLoginAt !== null ? u.lastLoginAt.toISOString() : null,
      lockedAt: u.lockedAt !== null ? u.lockedAt.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
    })),
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      name: k.name,
      scopes: k.scopes,
      mode: k.mode,
      lastUsedAt: k.lastUsedAt !== null ? k.lastUsedAt.toISOString() : null,
      lastUsedIp: k.lastUsedIp,
      revokedAt: k.revokedAt !== null ? k.revokedAt.toISOString() : null,
      revokedReason: k.revokedReason,
      expiresAt: k.expiresAt !== null ? k.expiresAt.toISOString() : null,
      createdAt: k.createdAt.toISOString(),
    })),
    webhooks: {
      endpoints: webhookEndpoints.map((w) => ({
        id: w.id,
        url: w.url,
        label: w.label,
        isActive: w.disabledAt === null,
        events: w.events,
        createdAt: w.createdAt.toISOString(),
      })),
      health: webhookHealth,
    },
    tickets,
  });
}

/* ---------- Admin firm-user unlock ---------- */

export async function handleAdminUnlockFirmUser(
  ctx: AdminContext,
  firmId: string,
  firmUserId: string,
): Promise<NextResponse> {
  const { db, now } = ctx;

  if (!uuidSchema.safeParse(firmId).success || !uuidSchema.safeParse(firmUserId).success) {
    return ctx.errorJson('validation_error', 'Invalid ID format.', 400);
  }

  // Scope the target to this firm so we can't accidentally clear a
  // lock on a user belonging to another firm.
  const userRows = await db
    .select({
      id: schema.firmUsers.id,
      firmId: schema.firmUsers.firmId,
      role: schema.firmUsers.role,
      lockedAt: schema.firmUsers.lockedAt,
    })
    .from(schema.firmUsers)
    .where(eq(schema.firmUsers.id, firmUserId))
    .limit(1);
  const user = userRows[0];
  if (user === undefined || user.firmId !== firmId) {
    return ctx.errorJson('not_found', 'Teammate not found.', 404);
  }
  if (user.lockedAt === null) {
    return ctx.errorJson('conflict', 'Teammate is not currently locked.', 409);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.firmUsers)
      .set({
        lockedAt: null,
        lockedUntil: null,
        failedLoginCount: 0,
        updatedAt: now,
      })
      .where(eq(schema.firmUsers.id, firmUserId));

    await writeAudit(tx, {
      action: 'firm.user_unlocked',
      actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'firm_user', id: firmUserId }),
      context: buildAuditRequestContext({
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      }),
      meta: {
        firmId,
        previousLockedAt: user.lockedAt !== null ? user.lockedAt.toISOString() : null,
      },
      ts: now,
    });
  });

  return ctx.json({ ok: true });
}

/* ---------- Update ---------- */

export interface UpdateFirmInput {
  readonly name?: string | undefined;
  readonly tier?: string | undefined;
  readonly contactEmail?: string | undefined;
  readonly countryCode?: string | undefined;
  readonly notes?: string | undefined;
}

export async function handleUpdateFirm(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  firmId: string,
  input: UpdateFirmInput,
): Promise<AdminFirmListItem | null> {
  const result = await deps.updateFirm(ctx.db, firmId, input);
  if (result === null) return null;

  // Write audit after the mutation succeeded. `meta` carries the
  // delta only (fields present in the input) so the trail doesn't
  // duplicate unchanged columns.
  const tierChanged = input.tier !== undefined;
  await writeAudit(ctx.db, {
    action: tierChanged ? 'firm.tier_changed' : 'firm.updated',
    actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'firm', id: firmId }),
    context: buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
    meta: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
      ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    ts: ctx.now,
  });

  return result;
}

/* ---------- Soft delete ---------- */

export async function handleSoftDeleteFirm(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  firmId: string,
): Promise<void> {
  await deps.softDeleteFirm(ctx.db, firmId, ctx.now);
  await writeAudit(ctx.db, {
    action: 'firm.deleted',
    actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'firm', id: firmId }),
    context: buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
    meta: { softDelete: true },
    ts: ctx.now,
  });
}

/* ---------- Restore ---------- */

export async function handleRestoreFirm(
  deps: AdminFirmsDeps,
  ctx: AdminContext,
  firmId: string,
): Promise<void> {
  await deps.restoreFirm(ctx.db, firmId);
  await writeAudit(ctx.db, {
    action: 'firm.restored',
    actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'firm', id: firmId }),
    context: buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
    meta: {},
    ts: ctx.now,
  });
}
