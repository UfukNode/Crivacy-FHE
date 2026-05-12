/**
 * Single source of truth for the "reset a customer's KYC state to
 * baseline" UPDATE payload.
 *
 * Three independent code paths reset a customer to `kyc_0`:
 *
 *   1. Admin `reset_kyc` action (`server/handlers/admin-customers.ts`)
 *      — operator-driven manual reset.
 *   2. Didit `Kyc Expired` webhook (`server/handlers/didit-webhook.ts`
 *      `handleCustomerWebhook` kyc_expired branch) — TTL elapsed on
 *      a previously-approved credential.
 *   3. Didit user-entity revoke (`server/handlers/didit-webhook.ts`
 *      `handleUserEntityWebhook`) — Didit operator deleted/blocked
 *      the user via dashboard or API.
 *
 * Post PII-purge (migration `20260509000000`), the patch is reduced
 * to four fields — Crivacy stores ZERO raw PII columns, so there is
 * nothing to null out beyond the `kyc_*` lifecycle gates. The patch
 * lives here (not inline in three callers) so any future addition
 * (e.g. a new lifecycle-gate boolean) only updates one place.
 *
 * The function returns a plain object so callers can spread it into
 * a Drizzle `.set({ ...kycResetCustomerPatch(now), revokedAt, ... })`
 * call when they need to add path-specific stamps (e.g. the Didit
 * user-entity revoke also stamps `revoked_at` + `revoked_reason`).
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { customers, kycSessions } from '@/lib/db/schema';
import { REVOKABLE_SESSION_STATUSES } from '@/lib/kyc/session-status-display';

/**
 * Drizzle UPDATE patch type — every field optional so callers can
 * spread + extend. `typeof customers.$inferInsert` would be too
 * strict (it requires the NOT NULL columns). `Partial<...>` keeps
 * the type-safety on column names while letting us emit a partial
 * patch.
 */
export type KycResetCustomerPatch = Partial<typeof customers.$inferInsert>;

/**
 * Build the canonical reset patch. Shape: drop level + score + lock
 * flag, stamp `updated_at`. No PII fields touched (none stored).
 *
 * Callers that need path-specific extra stamps (e.g. revoke audit
 * fields, banned flag) spread the result and add their own keys:
 *
 *   await db.update(customers).set({
 *     ...kycResetCustomerPatch(ctx.now),
 *     revokedAt: ctx.now,
 *     revokedReason: 'didit_user_deleted',
 *   }).where(eq(customers.id, customerId));
 *
 * `now` is a parameter (not `new Date()`) so handlers that pin a
 * `RequestContext.now` for deterministic audit-row timestamps stay
 * in lock-step.
 */
export function kycResetCustomerPatch(now: Date): KycResetCustomerPatch {
  return {
    kycLevel: 'kyc_0',
    kycScore: 0,
    kycFieldsLocked: false,
    updatedAt: now,
  };
}

/**
 * Revoke every customer-flow KYC session that is still in a revokable
 * (i.e. non-terminal) state. Companion to {@link kycResetCustomerPatch}
 * — when a code path resets the customer row to baseline it must ALSO
 * close any open `kyc_sessions` row, otherwise the dashboard surface
 * keeps showing the stale "in review" / "in progress" stepper because
 * the partial unique index `kyc_sessions_customer_workflow_active_key`
 * still considers the row active.
 *
 * Four code paths reach this helper:
 *
 *   1. {@link banCustomer} — orchestrator for fraud bans.
 *   2. Didit `user.*` revoke webhook (operator deleted/blocked the
 *      user upstream).
 *   3. Didit `Kyc Expired` webhook — credential TTL elapsed.
 *   4. Admin `reset_kyc` action — operator-driven manual reset.
 *
 * Status list sourced from {@link REVOKABLE_SESSION_STATUSES} so the
 * "what counts as still touchable?" answer lives in exactly one place
 * (`lib/kyc/session-status-display.ts`); adding a new state to that
 * list automatically widens this helper's WHERE clause.
 *
 * Returns the count of rows actually flipped, mirroring the shape the
 * Didit user-entity revoke flow logs into the audit `meta`. Callers
 * that don't need the count can ignore the return value safely.
 */
export async function revokeActiveKycSessions(
  db: CrivacyDatabase,
  customerId: string,
  now: Date,
  failureReason: string,
): Promise<number> {
  const result = await db
    .update(kycSessions)
    .set({
      status: 'revoked',
      completedAt: now,
      failureReason,
      updatedAt: now,
    })
    .where(
      and(
        eq(kycSessions.kind, 'customer' as const),
        eq(kycSessions.customerId, customerId),
        inArray(kycSessions.status, [...REVOKABLE_SESSION_STATUSES]),
      ),
    )
    .returning({ id: kycSessions.id });

  return result.length;
}
