/**
 * Firm team management — list teammates, invite new ones, change
 * roles, remove teammates. Enforced via the central role engine
 * (`lib/firm/roles.ts`) so every policy rule lives in one place and
 * every endpoint funnels its authorization through the same pure
 * validators.
 *
 * Invitations reuse the owner-onboarding token mechanism introduced
 * for admin-created firms: a SHA-256-hashed single-use token lives
 * in `firm_user_invites` and the recipient completes setup via
 * `/dashboard/accept-invite?token=...`. There's no separate "team
 * invite" path — one welcome flow, two triggers (admin-seeded vs
 * owner-invited).
 *
 * Every mutation writes an audit entry (`firm.user_invited`,
 * `firm.user_role_changed`, `firm.user_removed`) so the trail
 * captures who did what and why across both admin-seeded and
 * owner-invited flows.
 *
 * @module
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { generateInviteToken, hashInviteToken } from '@/lib/auth/invite-token';

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { enqueueEmailFromRoute } from '@/lib/email';
import { firmUserInviteEmail } from '@/lib/email/templates';
import { getAppUrl } from '@/lib/env/app-url';
import {
  capabilitiesFor,
  hasCapability,
  isFirmRole,
  validateInviteRole,
  validateRemove,
  validateRoleTransition,
  type FirmRole,
} from '@/lib/firm/roles';
import * as schema from '@/lib/db/schema';
import { syncFirmUserHierarchyRole } from '@/lib/rbac';
import { FIRM_INVITE_TTL_HOURS } from '../repositories/admin';
import { emailSchema } from '@/lib/validation/auth';
import { uuidSchema } from '@/lib/validation/common';
import { firmRoleSchema } from '@/lib/validation/firm-roles';

import type { DashboardContext } from '../context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditCtxFrom(ctx: DashboardContext) {
  return buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

function actorFromCtx(ctx: DashboardContext) {
  return firmUserActor({
    id: ctx.user.id,
    label: ctx.user.email,
    firmId: ctx.firm.id,
  });
}

function summariseUser(row: {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly lastLoginAt: Date | null;
  readonly lockedAt: Date | null;
  readonly createdAt: Date;
}) {
  const status: 'invited' | 'active' | 'locked' =
    row.lockedAt !== null ? 'locked' : row.acceptedAt !== null ? 'active' : 'invited';
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status,
    invitedAt: row.invitedAt !== null ? row.invitedAt.toISOString() : null,
    acceptedAt: row.acceptedAt !== null ? row.acceptedAt.toISOString() : null,
    lastLoginAt: row.lastLoginAt !== null ? row.lastLoginAt.toISOString() : null,
    lockedAt: row.lockedAt !== null ? row.lockedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List teammates
// ---------------------------------------------------------------------------

export async function handleListFirmTeam(ctx: DashboardContext): Promise<NextResponse> {
  const { firm, user, db } = ctx;

  const rows = await db
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
    .where(eq(schema.firmUsers.firmId, firm.id))
    .orderBy(schema.firmUsers.createdAt);

  return ctx.json({
    members: rows.map(summariseUser),
    viewer: {
      id: user.id,
      role: user.role,
      capabilities: capabilitiesFor(user.role),
    },
  });
}

// ---------------------------------------------------------------------------
// Invite a teammate
// ---------------------------------------------------------------------------

const InviteBody = z.object({
  email: emailSchema,
  role: firmRoleSchema,
});

export async function handleInviteFirmTeammate(
  ctx: DashboardContext,
): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

  let raw: unknown;
  try {
    raw = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = InviteBody.safeParse(raw);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }
  const { email, role } = parsed.data;

  // Central policy engine owns every invite invariant.
  const invariant = validateInviteRole({ actor: user.role, targetRole: role });
  if (!invariant.ok) {
    return ctx.errorJson(
      invariant.code ?? 'forbidden',
      invariant.message ?? 'Invite rejected.',
      403,
    );
  }

  // Reject if the email already has a row on this firm (regardless of
  // status — invited / accepted / locked). Two rows with the same
  // email on the same firm would break the unique index anyway.
  const existing = await db
    .select({ id: schema.firmUsers.id, acceptedAt: schema.firmUsers.acceptedAt })
    .from(schema.firmUsers)
    .where(
      and(
        eq(schema.firmUsers.firmId, firm.id),
        sql`lower(${schema.firmUsers.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return ctx.errorJson(
      'conflict',
      'A teammate with this email is already on this firm.',
      409,
    );
  }

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(now.getTime() + FIRM_INVITE_TTL_HOURS * 60 * 60 * 1000);

  const newUserId = await db.transaction(async (tx) => {
    const firmUserRows = await tx
      .insert(schema.firmUsers)
      .values({
        firmId: firm.id,
        email,
        passwordHash: null,
        role: role as FirmRole,
        invitedBy: user.id,
        invitedAt: now,
      })
      .returning({ id: schema.firmUsers.id });
    const firmUserRow = firmUserRows[0];
    if (firmUserRow === undefined) {
      throw new Error('Failed to create firm teammate row');
    }

    await tx.insert(schema.firmUserInvites).values({
      firmUserId: firmUserRow.id,
      tokenHash,
      createdByAdminId: null,
      expiresAt,
      createdAt: now,
    });

    // BUG #41 fix: align user_roles with the chosen hierarchy role at
    // invite time. Effective permissions resolve via user_roles only;
    // skipping this leaves the new teammate at zero perms after they
    // accept and log in for the first time.
    await syncFirmUserHierarchyRole(tx, firmUserRow.id, role as FirmRole, user.id);

    await writeAudit(tx, {
      action: 'firm.user_invited',
      actor: actorFromCtx(ctx),
      target: uuidTarget({ kind: 'firm_user', id: firmUserRow.id }),
      context: auditCtxFrom(ctx),
      meta: {
        firmId: firm.id,
        email,
        role,
        invitedBy: user.id,
        source: 'team_owner',
        expiresAt: expiresAt.toISOString(),
      },
      ts: now,
    });

    return firmUserRow.id;
  });

  const appUrl = getAppUrl();
  // Fragment delivery (`#token=…`) keeps the token out of Referer
  // headers, server access logs, and CDN/proxy traces — URL fragments
  // never travel over the wire. Only the client-side React bundle
  // reads `window.location.hash` to POST it to /validate.
  const acceptUrl = `${appUrl}/dashboard/accept-invite#token=${encodeURIComponent(rawToken)}`;

  await enqueueEmailFromRoute(db, {
    to: email,
    content: firmUserInviteEmail({
      firmName: firm.displayName,
      recipientEmail: email,
      acceptUrl,
      expiresInHours: FIRM_INVITE_TTL_HOURS,
    }),
    emailType: 'welcome',
    userId: newUserId,
    metadata: {
      firmId: firm.id,
      kind: 'firm_team_invite',
    },
  });

  return ctx.json({ id: newUserId, expiresAt: expiresAt.toISOString() }, 201);
}

// ---------------------------------------------------------------------------
// Change teammate role
// ---------------------------------------------------------------------------

const RoleChangeBody = z.object({
  role: firmRoleSchema,
});

export async function handleChangeFirmUserRole(
  ctx: DashboardContext,
  targetUserId: string,
  /**
   * Pre-parsed body. The route handler runs the destructive-reauth
   * envelope parse (which consumes `request.body`), then forwards
   * the remaining keys here so this handler can validate the
   * role-change shape without a second body read.
   */
  body: unknown,
): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

  if (!uuidSchema.safeParse(targetUserId).success) {
    return ctx.errorJson('validation_error', 'Invalid member ID.', 400);
  }

  const parsed = RoleChangeBody.safeParse(body);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }
  const { role: newRole } = parsed.data;

  // `manageTeam` capability gates the endpoint at the policy layer.
  if (!hasCapability(user.role, 'manageTeam')) {
    return ctx.errorJson('forbidden', 'You cannot manage teammates.', 403);
  }

  // BUG #55 race fix: SELECT count + validate + UPDATE serialized via
  // per-firm advisory lock + single transaction. The prior code computed
  // `ownerCountAfter` from a SELECT taken outside the UPDATE's tx, so
  // two paralel demote-each-other requests (two co-owners, each demoting
  // the other) both observed `count=2 → after=1` and both UPDATE'd —
  // final state: 0 owners. The lock + re-read inside the tx means the
  // loser sees the post-mutation count (1 → after=0) and gets the
  // typed `owner_invariant_violated` 409 the audit always claimed.
  type Verdict =
    | { readonly kind: 'ok' }
    | { readonly kind: 'noop' }
    | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly status: number };

  const verdict: Verdict = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'firm_team:' + firm.id}))`,
    );

    const targetRows = await tx
      .select({
        id: schema.firmUsers.id,
        role: schema.firmUsers.role,
        firmId: schema.firmUsers.firmId,
      })
      .from(schema.firmUsers)
      .where(eq(schema.firmUsers.id, targetUserId))
      .limit(1);
    const target = targetRows[0];
    if (target === undefined || target.firmId !== firm.id) {
      return { kind: 'error', code: 'not_found', message: 'Teammate not found.', status: 404 };
    }
    if (!isFirmRole(target.role)) {
      return { kind: 'error', code: 'internal_error', message: 'Teammate has an unknown role.', status: 500 };
    }
    if (target.role === newRole) {
      return { kind: 'noop' };
    }

    const wasOwner = target.role === 'owner';
    const becomesOwner = newRole === 'owner';
    const ownerRows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(schema.firmUsers)
      .where(and(eq(schema.firmUsers.firmId, firm.id), eq(schema.firmUsers.role, 'owner')));
    const baseOwnerCount = ownerRows[0]?.value ?? 0;
    let ownerCountAfter = baseOwnerCount;
    if (wasOwner) ownerCountAfter -= 1;
    if (becomesOwner) ownerCountAfter += 1;
    ownerCountAfter = Math.max(0, ownerCountAfter);

    const result = validateRoleTransition({
      actor: user.role,
      targetCurrent: target.role,
      targetNew: newRole,
      isSelf: target.id === user.id,
      ownerCountAfter,
    });
    if (!result.ok) {
      const status = result.code === 'owner_invariant_violated' ? 409 : 403;
      return { kind: 'error', code: result.code ?? 'forbidden', message: result.message ?? 'Rejected.', status };
    }

    // AUD-INT-AUTHZ-IDOR-003 fix: UPDATE WHERE must repeat the firm
    // scope. SELECT above validated `target.firmId === firm.id` and
    // `firm_users.firm_id` is immutable in practice, but the canonical
    // pattern is always "id + firmId" on every mutation so a future
    // schema change (cross-firm transfer, rehoming) cannot silently
    // introduce a cross-firm escalation window.
    await tx
      .update(schema.firmUsers)
      .set({ role: newRole as FirmRole, updatedAt: now })
      .where(and(eq(schema.firmUsers.id, target.id), eq(schema.firmUsers.firmId, firm.id)));

    // BUG #41 fix: re-point user_roles to the preset matching the new
    // hierarchy role. Without this the user keeps the *old* role's
    // effective permissions until ops re-runs seed-rbac.ts — the
    // change UI says "promoted to admin" but the permission gate
    // still treats them as a viewer.
    await syncFirmUserHierarchyRole(tx, target.id, newRole as FirmRole, user.id);

    await writeAudit(tx, {
      action: 'firm.user_role_changed',
      actor: actorFromCtx(ctx),
      target: uuidTarget({ kind: 'firm_user', id: target.id }),
      context: auditCtxFrom(ctx),
      meta: {
        firmId: firm.id,
        from: target.role,
        to: newRole,
      },
      ts: now,
    });
    return { kind: 'ok' };
  });

  if (verdict.kind === 'error') {
    return ctx.errorJson(verdict.code, verdict.message, verdict.status);
  }
  if (verdict.kind === 'noop') {
    return ctx.json({ ok: true, noop: true });
  }
  return ctx.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Remove (soft delete) a teammate
// ---------------------------------------------------------------------------

export async function handleRemoveFirmTeammate(
  ctx: DashboardContext,
  targetUserId: string,
): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

  if (!uuidSchema.safeParse(targetUserId).success) {
    return ctx.errorJson('validation_error', 'Invalid member ID.', 400);
  }

  if (!hasCapability(user.role, 'manageTeam')) {
    return ctx.errorJson('forbidden', 'You cannot manage teammates.', 403);
  }

  // BUG #55 race fix (mirror of `handleChangeFirmUserRole`): owner-
  // count check + UPDATE serialized via per-firm advisory lock + single
  // transaction. Two paralel removes targeting the firm's last owners
  // both passed the floor check before; now the loser sees the post-
  // removal count and gets `owner_invariant_violated` 409.
  type Verdict =
    | { readonly kind: 'ok' }
    | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly status: number };

  const verdict: Verdict = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'firm_team:' + firm.id}))`,
    );

    const targetRows = await tx
      .select({
        id: schema.firmUsers.id,
        role: schema.firmUsers.role,
        firmId: schema.firmUsers.firmId,
      })
      .from(schema.firmUsers)
      .where(eq(schema.firmUsers.id, targetUserId))
      .limit(1);
    const target = targetRows[0];
    if (target === undefined || target.firmId !== firm.id) {
      return { kind: 'error', code: 'not_found', message: 'Teammate not found.', status: 404 };
    }
    if (!isFirmRole(target.role)) {
      return { kind: 'error', code: 'internal_error', message: 'Teammate has an unknown role.', status: 500 };
    }

    const wasOwner = target.role === 'owner';
    const ownerRows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(schema.firmUsers)
      .where(and(eq(schema.firmUsers.firmId, firm.id), eq(schema.firmUsers.role, 'owner')));
    const baseOwnerCount = ownerRows[0]?.value ?? 0;
    let ownerCountAfter = baseOwnerCount;
    if (wasOwner) ownerCountAfter -= 1;
    ownerCountAfter = Math.max(0, ownerCountAfter);

    const result = validateRemove({
      actor: user.role,
      targetRole: target.role,
      isSelf: target.id === user.id,
      ownerCountAfter,
    });
    if (!result.ok) {
      const status = result.code === 'owner_invariant_violated' ? 409 : 403;
      return { kind: 'error', code: result.code ?? 'forbidden', message: result.message ?? 'Rejected.', status };
    }

    // "Remove" = lock the account so the user can't log in while we
    // retain their audit history. Hard-deleting would orphan
    // tickets, audit rows, etc.
    //
    // AUD-INT-AUTHZ-IDOR-003 fix: mirror the `handleChangeFirmUserRole`
    // pattern — repeat the firm scope on the UPDATE even though SELECT
    // already validated it.
    await tx
      .update(schema.firmUsers)
      .set({ lockedAt: now, updatedAt: now })
      .where(and(eq(schema.firmUsers.id, target.id), eq(schema.firmUsers.firmId, firm.id)));

    // Also burn any outstanding invite so a removed-before-accept
    // teammate cannot come back via the old magic link.
    await tx
      .update(schema.firmUserInvites)
      .set({ usedAt: now })
      .where(
        and(
          eq(schema.firmUserInvites.firmUserId, target.id),
          isNull(schema.firmUserInvites.usedAt),
        ),
      );

    await writeAudit(tx, {
      action: 'firm.user_removed',
      actor: actorFromCtx(ctx),
      target: uuidTarget({ kind: 'firm_user', id: target.id }),
      context: auditCtxFrom(ctx),
      meta: {
        firmId: firm.id,
        role: target.role,
      },
      ts: now,
    });
    return { kind: 'ok' };
  });

  if (verdict.kind === 'error') {
    return ctx.errorJson(verdict.code, verdict.message, verdict.status);
  }
  return ctx.json({ ok: true });
}
