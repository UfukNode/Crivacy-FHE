/**
 * Admin customer management handlers.
 *
 * Each exported function takes a typed `AdminContext` and returns a
 * `NextResponse`. The route files wire these handlers through the
 * `adminRoute` middleware pipeline.
 *
 * Handlers enforce role requirements at the route level (minRole: 'admin').
 * Every mutation writes an audit entry via the standard audit writer.
 *
 * @module
 */

import { NextResponse } from 'next/server';
import { and, count, desc, eq, ilike, isNull, or } from 'drizzle-orm';

import type { AdminContext } from '../context';
import * as schema from '@/lib/db/schema';
import { writeAudit } from '@/lib/audit/writer';
import { adminUserActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { banCustomer, revokeActiveCredentials } from '@/lib/fraud/ban';
import { removeBlacklistByCustomerId } from '@/lib/fraud/blacklist';
import {
  kycResetCustomerPatch,
  revokeActiveKycSessions,
} from '@/lib/customer/kyc-reset';
import { notifyCustomerStatusChange } from '@/lib/notification';
import { readAvatarFile } from './customer-profile';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for customer listings. */
const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size for customer listings. */
const MAX_PAGE_SIZE = 100;

/** Maximum page number to prevent absurd offsets. */
const MAX_PAGE_NUMBER = 10000;

/** Valid customer status values. */
const VALID_STATUSES = [
  'pending_verification',
  'active',
  'suspended',
  'locked',
  'banned',
] as const;

/** Valid customer KYC level values. */
const VALID_KYC_LEVELS = [
  'kyc_0',
  'kyc_1',
  'kyc_2',
  'kyc_3',
  'kyc_4',
] as const;

/** Valid actions for the status update endpoint. */
const VALID_ACTIONS = [
  'suspend',
  'activate',
  'lock',
  'unlock',
  'ban',
  'reset_kyc',
] as const;

type CustomerAction = typeof VALID_ACTIONS[number];

type CustomerStatus = typeof VALID_STATUSES[number];

// ---------------------------------------------------------------------------
// State transition rules
// ---------------------------------------------------------------------------

/**
 * Centralized state transition rules for admin customer actions.
 *
 * Each action specifies which customer statuses it can transition FROM.
 * If the customer's current status is not in the list, the action is
 * rejected with 409 Conflict before any side effects occur.
 *
 * Notable rules:
 *   - `suspend` / `lock` / `reset_kyc` exclude `banned` — a banned customer
 *     must be unbanned first. Banning is a terminal action that revokes
 *     everything; downgrading to suspend/lock is illogical.
 *   - `unlock` only accepts `locked` — it's a targeted reversal.
 *   - `activate` accepts all non-active statuses including `banned` (the
 *     superadmin check is enforced separately in step 4).
 */
const ACTION_VALID_FROM: Readonly<Record<CustomerAction, readonly CustomerStatus[]>> = {
  suspend:   ['active', 'pending_verification', 'locked'],
  activate:  ['suspended', 'locked', 'banned', 'pending_verification'],
  lock:      ['active', 'pending_verification', 'suspended'],
  unlock:    ['locked'],
  ban:       ['active', 'pending_verification', 'suspended', 'locked'],
  reset_kyc: ['active', 'pending_verification', 'suspended', 'locked'],
};

/**
 * Additional validation checks beyond status transitions. Returns a
 * conflict message string if the action should be rejected, or `null`
 * if the action is valid.
 *
 * Kept as a map so new action-specific guards can be added without
 * touching the main handler flow.
 */
const ACTION_EXTRA_CHECKS: Partial<Readonly<Record<
  CustomerAction,
  (customer: typeof schema.customers.$inferSelect) => string | null
>>> = {
  reset_kyc: (customer) => {
    if (customer.kycLevel === 'kyc_0' && customer.kycScore === 0) {
      return 'Customer KYC is already at base level. Nothing to reset.';
    }
    return null;
  },
};

/**
 * Build a descriptive conflict message when an action is rejected
 * due to the customer's current status not being in `ACTION_VALID_FROM`.
 */
function buildTransitionConflictMessage(action: CustomerAction, currentStatus: string): string {
  if (currentStatus === 'banned' && action !== 'activate') {
    return `Cannot ${action.replace('_', ' ')} a banned customer. Unban the customer first.`;
  }
  // Same-state conflicts
  const SAME_STATE: Partial<Record<CustomerAction, string>> = {
    suspend:  'Customer is already suspended.',
    lock:     'Customer is already locked.',
    ban:      'Customer is already banned.',
    activate: 'Customer is already active.',
    unlock:   'Customer is not locked.',
  };
  return SAME_STATE[action] ?? `Cannot perform '${action}' on a customer with status '${currentStatus}'.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an audit request context from a base admin context.
 */
function auditCtxFrom(ctx: AdminContext) {
  return buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

/**
 * Parse a positive integer from a URL search parameter.
 * Returns the default if absent or invalid.
 */
function parsePositiveInt(value: string | null, defaultValue: number, max: number): number {
  if (value === null) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

/**
 * Build the admin-facing avatar URL for a customer. Returns `null` if
 * the customer has no avatar uploaded. The URL points to the admin
 * avatar serve endpoint (gated by `adminRoute`), not the customer one.
 */
function buildAdminAvatarUrl(customerId: string, storageKey: string | null): string | null {
  return storageKey !== null ? `/api/internal/admin/customers/${customerId}/avatar` : null;
}

/**
 * Map a customer row to the API response shape, excluding `passwordHash`.
 * Converts all Date fields to ISO strings.
 *
 * `avatarUrl` points to the admin avatar serve endpoint; the raw
 * `avatarStorageKey` is not leaked to the client.
 */
function mapCustomerRow(row: typeof schema.customers.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? null,
    status: row.status,
    kycLevel: row.kycLevel,
    kycScore: row.kycScore,
    phone: row.phone ?? null,
    // Identity + address PII intentionally omitted — Crivacy stores
    // none of these fields. Admin operators see verification proof
    // (level + score + credential hash + Didit deep-links) via
    // the kyc-credentials lookup, not raw PII. See
    // .claude/PII-PURGE-AND-COMPOSITE-HASH.md for the doctrine.
    kycFieldsLocked: row.kycFieldsLocked,
    avatarUrl: buildAdminAvatarUrl(row.id, row.avatarStorageKey ?? null),
    lockedAt: row.lockedAt !== null ? row.lockedAt.toISOString() : null,
    lockReason: row.lockReason ?? null,
    failedLoginAttempts: row.failedLoginAttempts,
    lastLoginAt: row.lastLoginAt !== null ? row.lastLoginAt.toISOString() : null,
    emailVerifiedAt: row.emailVerifiedAt !== null ? row.emailVerifiedAt.toISOString() : null,
    onboardingDismissedAt: row.onboardingDismissedAt !== null ? row.onboardingDismissedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
  } as const;
}

/**
 * Map a customer row to the abbreviated list shape (fewer fields).
 */
function mapCustomerListRow(row: typeof schema.customers.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? null,
    status: row.status,
    kycLevel: row.kycLevel,
    kycScore: row.kycScore,
    // No PII columns — see mapCustomerRow docblock above.
    emailVerifiedAt: row.emailVerifiedAt !== null ? row.emailVerifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt !== null ? row.lastLoginAt.toISOString() : null,
  } as const;
}

/**
 * UUID v4 format check to validate path params before hitting DB.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuidV4(value: string): boolean {
  return UUID_V4_REGEX.test(value);
}

// ---------------------------------------------------------------------------
// handleListCustomers
// ---------------------------------------------------------------------------

/**
 * GET /api/internal/admin/customers
 *
 * List customers with optional search, status filter, KYC level filter,
 * and offset-based pagination. Excludes soft-deleted customers.
 *
 * Query parameters:
 *   - `search` — ILIKE match against email or displayName
 *   - `status` — exact match against the customer status enum
 *   - `kycLevel` — exact match against the customer KYC level enum
 *   - `page` — page number (default 1)
 *   - `limit` — page size (default 20, max 100)
 *
 * Returns: `{ customers, total, page, limit, totalPages }`
 */
export async function handleListCustomers(ctx: AdminContext): Promise<NextResponse> {
  const { db, request } = ctx;
  const url = new URL(request.url);

  const search = url.searchParams.get('search');
  const statusFilter = url.searchParams.get('status');
  const kycLevelFilter = url.searchParams.get('kycLevel');
  const page = parsePositiveInt(url.searchParams.get('page'), 1, MAX_PAGE_NUMBER);
  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  // Build conditions — always exclude soft-deleted customers
  const conditions: ReturnType<typeof eq>[] = [
    isNull(schema.customers.deletedAt),
  ];

  // Search filter (ILIKE against email or displayName)
  if (search !== null && search.trim().length > 0) {
    const searchPattern = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(schema.customers.email, searchPattern),
        ilike(schema.customers.displayName, searchPattern),
      )!,
    );
  }

  // Status filter
  if (
    statusFilter !== null &&
    statusFilter.length > 0 &&
    (VALID_STATUSES as readonly string[]).includes(statusFilter)
  ) {
    conditions.push(
      eq(schema.customers.status, statusFilter as typeof VALID_STATUSES[number]),
    );
  }

  // KYC level filter
  if (
    kycLevelFilter !== null &&
    kycLevelFilter.length > 0 &&
    (VALID_KYC_LEVELS as readonly string[]).includes(kycLevelFilter)
  ) {
    conditions.push(
      eq(schema.customers.kycLevel, kycLevelFilter as typeof VALID_KYC_LEVELS[number]),
    );
  }

  const whereClause = and(...conditions);

  // Fetch total count
  const totalResult = await db
    .select({ value: count() })
    .from(schema.customers)
    .where(whereClause);
  const total = totalResult[0]?.value ?? 0;

  // Fetch page
  const rows = await db
    .select()
    .from(schema.customers)
    .where(whereClause)
    .orderBy(desc(schema.customers.createdAt))
    .limit(limit)
    .offset(offset);

  return ctx.json({
    customers: rows.map(mapCustomerListRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}

// ---------------------------------------------------------------------------
// handleGetCustomerDetail
// ---------------------------------------------------------------------------

/**
 * GET /api/internal/admin/customers/:id
 *
 * Returns the full customer record (excluding passwordHash) together with:
 *   - KYC sessions (from `kyc_sessions WHERE kind = 'customer'`)
 *   - Recent tickets (last 10)
 *   - Assigned roles (via `user_roles` + `roles` join)
 *
 * Excludes soft-deleted customers.
 */
export async function handleGetCustomerDetail(
  ctx: AdminContext,
  customerId: string,
): Promise<NextResponse> {
  const { db } = ctx;

  // --- 1. Validate UUID format ---
  if (!isValidUuidV4(customerId)) {
    return ctx.errorJson('validation_error', 'Invalid customer ID format.', 400);
  }

  // --- 2. Fetch the customer ---
  const customerRows = await db
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

  // --- 3. Fetch KYC sessions ---
  // Sprint 7 Phase F — unified table read with kind filter.
  const kycSessions = await db
    .select()
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.customerId, customerId),
      ),
    )
    .orderBy(desc(schema.kycSessions.createdAt));

  // --- 4. Fetch recent tickets (last 10) ---
  const recentTickets = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.creatorId, customerId),
        eq(schema.tickets.creatorType, 'customer'),
      ),
    )
    .orderBy(desc(schema.tickets.createdAt))
    .limit(10);

  // --- 5. Fetch assigned roles ---
  const assignedRoles = await db
    .select({
      userRole: schema.userRoles,
      role: schema.roles,
    })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(
      and(
        eq(schema.userRoles.userId, customerId),
        eq(schema.userRoles.userType, 'customer'),
      ),
    );

  // --- 6. Fetch credential history ---
  // Sprint 7 unified `kyc_credentials_meta`: customer-flow rows store
  // the customer id in `user_ref` (text). Pull the full lifecycle
  // (active + superseded + revoked + expired) so the admin UI can
  // render a complete history; the page splits "active vs archived"
  // client-side.
  const credentials = await db
    .select({
      id: schema.kycCredentialsMeta.id,
      level: schema.kycCredentialsMeta.level,
      status: schema.kycCredentialsMeta.status,
      identityVerified: schema.kycCredentialsMeta.identityVerified,
      addressVerified: schema.kycCredentialsMeta.addressVerified,
      chainContractId: schema.kycCredentialsMeta.chainContractId,
      chainNetwork: schema.kycCredentialsMeta.chainNetwork,
      chainUpdateId: schema.kycCredentialsMeta.chainUpdateId,
      supersededBy: schema.kycCredentialsMeta.supersededBy,
      revokedAt: schema.kycCredentialsMeta.revokedAt,
      revokedReason: schema.kycCredentialsMeta.revokedReason,
      createdAt: schema.kycCredentialsMeta.createdAt,
      confirmedAt: schema.kycCredentialsMeta.confirmedAt,
      // NFT mint surface — same row carries the optional NFT artefact
      // (when the customer minted an NFT after credential issue). UI
      // renders the NFT line conditionally on `nftContractId !== null`.
      nftContractId: schema.kycCredentialsMeta.nftContractId,
      nftMintedAt: schema.kycCredentialsMeta.nftMintedAt,
      nftBurnedAt: schema.kycCredentialsMeta.nftBurnedAt,
      // NFT mint's own chain update id (separate chain tx from the
      // credential mint). Lets the admin UI deep-link the NFT row to
      // ccview.io/transfers/<update_id>/ same way as the credential.
      nftChainUpdateId: schema.kycCredentialsMeta.nftChainUpdateId,
    })
    .from(schema.kycCredentialsMeta)
    .where(eq(schema.kycCredentialsMeta.userRef, customerId))
    .orderBy(desc(schema.kycCredentialsMeta.createdAt));

  // AUD-X-THREAT-002 fix: admin PII access is a compliance-relevant
  // event (GDPR Art 30, SOC 2 CC6.8). This handler returns the
  // customer's email, display name, KYC sessions, tickets, and
  // roles — every successful read leaves a trail so an insider
  // enumerating records is auditable after the fact. No `meta.pii`
  // payload — the target id is enough; the request context
  // (actor / ip / user agent / request id) carries the rest.
  await writeAudit(db, {
    action: 'admin_user.customer_viewed',
    actor: adminUserActor({ id: ctx.user.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'customer', id: customerId }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {},
    ts: ctx.now,
  });

  return ctx.json({
    customer: mapCustomerRow(customer),
    credentials: credentials.map((c) => ({
      id: c.id,
      level: c.level,
      status: c.status,
      identityVerified: c.identityVerified,
      addressVerified: c.addressVerified,
      chainContractId: c.chainContractId,
      chainNetwork: c.chainNetwork,
      chainUpdateId: c.chainUpdateId,
      supersededBy: c.supersededBy,
      revokedAt: c.revokedAt !== null ? c.revokedAt.toISOString() : null,
      revokedReason: c.revokedReason,
      createdAt: c.createdAt.toISOString(),
      confirmedAt: c.confirmedAt !== null ? c.confirmedAt.toISOString() : null,
      nftContractId: c.nftContractId,
      nftMintedAt: c.nftMintedAt !== null ? c.nftMintedAt.toISOString() : null,
      nftBurnedAt: c.nftBurnedAt !== null ? c.nftBurnedAt.toISOString() : null,
      nftChainUpdateId: c.nftChainUpdateId,
    })),
    kycSessions: kycSessions.map((s) => ({
      id: s.id,
      customerId: s.customerId,
      workflowType: s.workflow,
      status: s.status,
      diditSessionId: s.diditSessionId ?? null,
      diditWorkflowId: s.diditWorkflowId,
      failureReason: s.failureReason ?? null,
      attempts: s.attempts,
      startedAt: s.startedAt.toISOString(),
      completedAt: s.completedAt !== null ? s.completedAt.toISOString() : null,
      expiresAt: s.expiresAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    recentTickets: recentTickets.map((t) => ({
      id: t.id,
      referenceNumber: t.referenceNumber,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      resolvedAt: t.resolvedAt !== null ? t.resolvedAt.toISOString() : null,
      closedAt: t.closedAt !== null ? t.closedAt.toISOString() : null,
    })),
    roles: assignedRoles.map((r) => ({
      id: r.role.id,
      name: r.role.name,
      displayName: r.role.displayName,
      description: r.role.description ?? null,
      userType: r.role.userType,
      isPreset: r.role.isPreset,
      isSystem: r.role.isSystem,
      assignedAt: r.userRole.assignedAt.toISOString(),
    })),
  });
}

// ---------------------------------------------------------------------------
// handleUpdateCustomerStatus
// ---------------------------------------------------------------------------

/**
 * PATCH /api/internal/admin/customers/:id
 *
 * Perform a status-changing action on a customer account.
 *
 * Body: `{ action: 'suspend' | 'activate' | 'lock' | 'unlock' | 'ban' | 'reset_kyc', reason?: string }`
 *
 * Each action validates the current state, applies the update, and writes
 * an audit entry. Returns the updated customer object.
 */
export async function handleUpdateCustomerStatus(
  ctx: AdminContext,
  customerId: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // --- 1. Validate UUID format ---
  if (!isValidUuidV4(customerId)) {
    return ctx.errorJson('validation_error', 'Invalid customer ID format.', 400);
  }

  // --- 2. Validate request body fields ---
  // Body is pre-parsed by the route layer (envelope split for the
  // destructive-reauth gate consumes the request stream once); the
  // route hands us the persisted-field rest, we validate the
  // action/reason shape here so handler-level errors stay aligned
  // with the legacy single-step contract.
  const action = body['action'];
  const reason = body['reason'];

  if (typeof action !== 'string' || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return ctx.errorJson(
      'validation_error',
      `action must be one of: ${VALID_ACTIONS.join(', ')}.`,
      400,
    );
  }

  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return ctx.errorJson('validation_error', 'reason must be a string when provided.', 400);
  }

  const validAction = action as CustomerAction;
  const reasonStr = typeof reason === 'string' && reason.length > 0 ? reason : null;

  // --- 3. Fetch existing customer ---
  const customerRows = await db
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

  // --- 4. Elevated role check for destructive actions ---
  //
  // `ban` moved off this list in the RBAC refactor (Faz 17) — the
  // middleware permission gate `admin.customer.ban` (Admin+) is the
  // sole authority. The matrix approved in Faz 0 explicitly grants
  // Admin the ability to ban; the old hard-coded Superadmin guard
  // contradicted that design.
  //
  // What STAYS on this list:
  //   * `reset_kyc` — no dedicated RBAC permission (PATCH endpoint
  //     uses `admin.customer.ban` as its middleware gate, shared
  //     with other status mutations). Reset KYC is the most severe
  //     irreversible action on this route, so the handler keeps a
  //     role floor until a dedicated permission is carved out.
  //   * `activate` from `banned` — this is "unban via PATCH", which
  //     per matrix is Superadmin-only. The middleware permission
  //     here is `admin.customer.ban` (Admin+), so without this
  //     guard an Admin could unban by routing through PATCH instead
  //     of the dedicated `/unban` endpoint (which uses the stricter
  //     `admin.customer.unban` permission).
  const requiresSuperadmin =
    validAction === 'reset_kyc' ||
    (validAction === 'activate' && customer.status === 'banned');

  if (requiresSuperadmin && user.role !== 'superadmin') {
    return ctx.errorJson(
      'role_forbidden',
      'This action requires superadmin role.',
      403,
    );
  }

  // --- 5. Centralized state transition validation ---
  const validFromStatuses = ACTION_VALID_FROM[validAction];
  if (!(validFromStatuses as readonly string[]).includes(customer.status)) {
    return ctx.errorJson('conflict', buildTransitionConflictMessage(validAction, customer.status), 409);
  }

  const extraCheck = ACTION_EXTRA_CHECKS[validAction];
  if (extraCheck !== undefined) {
    const extraError = extraCheck(customer);
    if (extraError !== null) {
      return ctx.errorJson('conflict', extraError, 409);
    }
  }

  // --- 6. Apply action-specific logic ---
  const actor = adminUserActor({ id: user.id, label: user.email });
  const target = uuidTarget({ kind: 'customer', id: customerId });
  const auditContext = auditCtxFrom(ctx);

  let updatedCustomer: typeof schema.customers.$inferSelect;

  switch (validAction) {
    case 'suspend': {
      // F-A1-AUDIT-ATOMIC-001 (Path-B Pattern A-in-tx): status flip
      // + active-session revoke + audit row commit / roll back as
      // one. A mid-audit DB error must not leave a customer marked
      // suspended without a forensic-trail entry, nor with their
      // active sessions revoked.
      const updatedRow = await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.customers)
          .set({
            status: 'suspended',
            updatedAt: now,
          })
          .where(eq(schema.customers.id, customerId))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          return null;
        }

        // Revoke all active customer sessions — suspended user cannot use the app
        await tx
          .update(schema.customerSessions)
          .set({ revokedAt: now, revokedReason: 'customer_suspended' })
          .where(
            and(
              eq(schema.customerSessions.customerId, customerId),
              isNull(schema.customerSessions.revokedAt),
            ),
          );

        await writeAudit(tx, {
          action: 'customer.suspended',
          actor,
          target,
          context: auditContext,
          meta: {
            previousStatus: customer.status,
            ...(reasonStr !== null ? { reason: reasonStr } : {}),
          },
          ts: now,
        });

        return row;
      });

      if (updatedRow === null) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = updatedRow;

      await notifyCustomerStatusChange(db, {
        customerId,
        action: 'suspended',
        reason: reasonStr ?? undefined,
      });
      break;
    }

    case 'activate': {
      const previousStatus = customer.status;
      // F-A1-AUDIT-ATOMIC-001 (Path-B): status flip +
      // (conditional) blacklist purge + per-purge audit + main
      // status-change audit commit / roll back as one. A
      // mid-write failure must not leave the user "active" with
      // their email still on the blacklist and no audit trail.
      const updatedRow = await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.customers)
          .set({
            status: 'active',
            lockedAt: null,
            lockReason: null,
            updatedAt: now,
          })
          .where(eq(schema.customers.id, customerId))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          return null;
        }

        // If unbanning, clear all associated blacklist entries
        if (previousStatus === 'banned') {
          const removedCount = await removeBlacklistByCustomerId(tx, customerId);

          if (removedCount > 0) {
            await writeAudit(tx, {
              action: 'blacklist.removed',
              actor,
              target,
              context: auditContext,
              meta: { removedCount, reason: 'customer_unbanned' },
              ts: now,
            });
          }
        }

        // Choose appropriate audit action based on what we're activating from
        const auditAction = previousStatus === 'banned'
          ? 'customer.unbanned' as const
          : previousStatus === 'suspended'
            ? 'customer.activated' as const
            : 'customer.unlocked' as const;

        await writeAudit(tx, {
          action: auditAction,
          actor,
          target,
          context: auditContext,
          meta: {
            previousStatus,
            ...(reasonStr !== null ? { reason: reasonStr } : {}),
          },
          ts: now,
        });

        return row;
      });

      if (updatedRow === null) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = updatedRow;

      // Map previousStatus to the appropriate notification action
      const notifAction = previousStatus === 'banned'
        ? 'unbanned' as const
        : previousStatus === 'suspended'
          ? 'activated' as const
          : 'unlocked' as const;

      await notifyCustomerStatusChange(db, {
        customerId,
        action: notifAction,
        reason: reasonStr ?? undefined,
      });
      break;
    }

    case 'lock': {
      // F-A1-AUDIT-ATOMIC-001 (Path-B): status flip + active-session
      // revoke + audit row commit / roll back as one. Same rationale
      // as the suspend branch — admin lock must never leave the user
      // session-revoked without an audit row.
      const updatedRow = await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.customers)
          .set({
            status: 'locked',
            lockedAt: now,
            lockReason: reasonStr,
            updatedAt: now,
          })
          .where(eq(schema.customers.id, customerId))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          return null;
        }

        // Revoke all active customer sessions — locked user cannot use the app
        await tx
          .update(schema.customerSessions)
          .set({ revokedAt: now, revokedReason: 'customer_locked' })
          .where(
            and(
              eq(schema.customerSessions.customerId, customerId),
              isNull(schema.customerSessions.revokedAt),
            ),
          );

        await writeAudit(tx, {
          action: 'customer.locked',
          actor,
          target,
          context: auditContext,
          meta: {
            previousStatus: customer.status,
            ...(reasonStr !== null ? { reason: reasonStr } : {}),
          },
          ts: now,
        });

        return row;
      });

      if (updatedRow === null) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = updatedRow;

      await notifyCustomerStatusChange(db, {
        customerId,
        action: 'locked',
        reason: reasonStr ?? undefined,
      });
      break;
    }

    case 'unlock': {
      // F-A1-AUDIT-ATOMIC-001 (Path-B): status flip + audit emit
      // commit / roll back as one.
      const updatedRow = await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.customers)
          .set({
            status: 'active',
            lockedAt: null,
            lockReason: null,
            failedLoginAttempts: 0,
            updatedAt: now,
          })
          .where(eq(schema.customers.id, customerId))
          .returning();

        const row = updated[0];
        if (row === undefined) {
          return null;
        }

        await writeAudit(tx, {
          action: 'customer.unlocked',
          actor,
          target,
          context: auditContext,
          meta: {
            previousStatus: customer.status,
            ...(reasonStr !== null ? { reason: reasonStr } : {}),
          },
          ts: now,
        });

        return row;
      });

      if (updatedRow === null) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = updatedRow;

      await notifyCustomerStatusChange(db, {
        customerId,
        action: 'unlocked',
        reason: reasonStr ?? undefined,
      });
      break;
    }

    case 'ban': {
      // Use the centralized ban orchestrator — handles status change,
      // blacklist, credential revoke, KYC session revoke, auth session
      // revoke, and full audit trail in one call.
      await banCustomer(db, {
        customerId,
        reason: 'manual_ban',
        source: 'admin_manual',
        bannedBy: user.id,
        notes: reasonStr ?? undefined,
        auditContext: auditCtxFrom(ctx),
      });

      // Re-fetch the updated customer row
      const updatedRows = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, customerId))
        .limit(1);

      const row = updatedRows[0];
      if (row === undefined) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = row;

      await notifyCustomerStatusChange(db, {
        customerId,
        action: 'banned',
        reason: reasonStr ?? undefined,
      });
      break;
    }

    case 'reset_kyc': {
      // 1. Revoke active credentials (chain + DB + webhook dispatch)
      const credentialsRevoked = await revokeActiveCredentials(
        db,
        customerId,
        now,
        'kyc_reset',
      );

      // 2. Reset customer KYC fields. Patch sourced from the shared
      // `kycResetCustomerPatch` helper — same call as the Didit
      // user-entity revoke + Kyc Expired branches in didit-webhook.ts.
      // Single source of truth for the "reset to baseline" UPDATE
      // shape (a future PII column addition only updates one place).
      const updated = await db
        .update(schema.customers)
        .set(kycResetCustomerPatch(now))
        .where(eq(schema.customers.id, customerId))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        return ctx.errorJson('internal_error', 'Failed to update customer.', 500);
      }
      updatedCustomer = row;

      // 3. Close any non-terminal KYC sessions — the row patch alone
      // leaves the latest session sitting in `in_progress` (or
      // similar), so the customer dashboard keeps rendering the
      // stale stepper after a reset. Same canonical helper the
      // Didit revoke + ban flows use — adding a new revokable
      // status updates `REVOKABLE_SESSION_STATUSES` once.
      const kycSessionsRevoked = await revokeActiveKycSessions(
        db,
        customerId,
        now,
        'admin_reset_kyc',
      );

      await writeAudit(db, {
        action: 'customer.kyc_reset',
        actor,
        target,
        context: auditContext,
        meta: {
          previousKycLevel: customer.kycLevel,
          previousKycScore: customer.kycScore,
          previousKycFieldsLocked: customer.kycFieldsLocked,
          credentialsRevoked,
          kycSessionsRevoked,
          ...(reasonStr !== null ? { reason: reasonStr } : {}),
        },
        ts: now,
      });

      await notifyCustomerStatusChange(db, {
        customerId,
        action: 'kyc_reset',
        reason: reasonStr ?? undefined,
      });
      break;
    }
  }

  return ctx.json({
    customer: mapCustomerRow(updatedCustomer),
  });
}

// ---------------------------------------------------------------------------
// handleServeCustomerAvatar
// ---------------------------------------------------------------------------

/**
 * GET /api/internal/admin/customers/:id/avatar
 *
 * Serve the avatar image for the specified customer. Gated by `adminRoute`;
 * any admin role (support/admin/superadmin) may view customer avatars,
 * matching the read-only access level of `handleGetCustomerDetail`.
 *
 * Response is marked `Cache-Control: private, no-store` — avatars are
 * treated as sensitive in the admin context (admin audit trails tie
 * observed customer data to admin identity).
 *
 * Returns 404 if the customer does not exist, is soft-deleted, has no
 * avatar uploaded, or the stored file is missing from disk.
 */
export async function handleServeCustomerAvatar(
  ctx: AdminContext,
  customerId: string,
): Promise<NextResponse> {
  // --- 1. Validate UUID format ---
  if (!isValidUuidV4(customerId)) {
    return ctx.errorJson('validation_error', 'Invalid customer ID format.', 400);
  }

  // --- 2. Fetch the avatar storage key (excluding soft-deleted customers) ---
  const rows = await ctx.db
    .select({ avatarStorageKey: schema.customers.avatarStorageKey })
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.id, customerId),
        isNull(schema.customers.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.avatarStorageKey === null) {
    return ctx.errorJson('not_found', 'Avatar not found.', 404);
  }

  // --- 3. Read file via shared helper ---
  const fileBuffer = await readAvatarFile(row.avatarStorageKey);
  if (fileBuffer === null) {
    return ctx.errorJson('not_found', 'Avatar not found.', 404);
  }

  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(fileBuffer.length),
      'x-request-id': ctx.requestId,
    },
  });
}
