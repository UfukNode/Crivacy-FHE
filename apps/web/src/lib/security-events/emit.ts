/**
 * Security event emit — the producer side of the outbox bus.
 *
 * Callers invoke {@link emitSecurityEvent} INSIDE the same transaction
 * as their state change (`tx.execute(...)` followed by
 * `emitSecurityEvent({ tx, ... })`). The row lands in
 * `security_events_outbox` atomically with the state mutation — either
 * both commit or both roll back.
 *
 * The caller does NOT dispatch side effects inline. The worker in
 * `security-events/dispatcher.ts` picks the row up on its next poll
 * and fans it out to subscribers (audit, email, webhook). This closes
 * the "state committed but audit entry missing" hole the previous
 * inline pattern had.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';

/* -------------------------------------------------------------------------- */
/*  Event taxonomy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Security-relevant event kinds. Prefixed by the actor audience so
 * consumers can filter cheaply. Adding a new event requires:
 *   1. An entry here.
 *   2. A version bump on `event_version` if the payload shape changes.
 *   3. A subscriber that knows how to handle it (or an explicit
 *      decision that no subscriber currently consumes it).
 */
export type SecurityEventType =
  // Password family — PasswordChangeEventPayload
  | 'customer.password_changed'
  | 'customer.password_set'
  | 'customer.password_reset'
  | 'firm_user.password_changed'
  | 'firm_user.password_reset'
  | 'admin_user.password_changed'
  // Email family — EmailChangedEventPayload / EmailAddedEventPayload
  | 'customer.email_changed'
  | 'customer.email_added'
  // Linked-account family — LinkedAccountEventPayload. The audit
  // row is already written inline at the link/unlink callsites
  // (`customer.google_linked` / `customer.wallet_unlinked` etc.) so
  // these events route through the email subscriber only — the audit
  // subscriber returns null for this family by design.
  | 'customer.google_linked'
  | 'customer.google_unlinked'
  | 'customer.wallet_linked'
  | 'customer.wallet_unlinked'
  // TOTP family — TotpEventPayload
  | 'firm_user.totp_enabled'
  | 'firm_user.totp_disabled'
  | 'firm_user.recovery_codes_regenerated'
  | 'admin_user.totp_enabled'
  | 'admin_user.totp_disabled'
  | 'admin_user.recovery_codes_regenerated'
  // Account-locked family — AccountLockedEventPayload. Emitted inside
  // the same tx as the failed-login counter UPDATE, on the threshold-
  // crossing edge (`justLocked === true`). The audit row is the
  // existing `<aud>.login.failed + meta.reason='*_locked_now'` entry —
  // this event exists purely so the email subscriber can notify the
  // victim. Audit subscriber returns null.
  | 'customer.account_locked'
  | 'firm_user.account_locked'
  | 'admin_user.account_locked'
  // Token-family revoke / refresh-token reuse-detection family —
  // SessionReuseDetectedEventPayload. Emitted inside the same tx as the
  // refresh route stale-replay branch UPDATE that flips `revoked_at`
  // (OWASP ASVS V3.5.5). The audit row is the inline
  // `<aud>.session.reuse_detected` entry written alongside this emit —
  // this event exists so the email subscriber can warn the victim.
  // Auto-idempotent: 2nd replay exits at the route's revoked_at gate
  // before reaching the stale-replay branch, so no duplicate emit.
  | 'customer.session_reuse_detected'
  | 'firm_user.session_reuse_detected'
  | 'admin_user.session_reuse_detected';

export type EventSubjectKind = 'customer' | 'firm_user' | 'admin_user';

export interface EmitSecurityEventInput {
  /**
   * Either a `CrivacyDatabase` (the emit opens its own transaction)
   * OR the inner `tx` object from an outer `db.transaction()` block
   * (the emit joins the outer transaction). Both satisfy the
   * `execute(sql)` contract this primitive uses.
   */
  readonly db: Pick<CrivacyDatabase, 'execute'>;
  readonly eventType: SecurityEventType;
  /** Bump when the payload schema changes; starts at 1. */
  readonly eventVersion?: number;
  readonly subject: { readonly kind: EventSubjectKind; readonly id: string };
  /**
   * Free-form JSONB payload. Keep it small and structured; do NOT
   * include secrets (password hashes, raw codes) — subscribers read
   * this verbatim.
   */
  readonly payload?: Record<string, unknown>;
  readonly now: Date;
}

/**
 * Write a row to the outbox. Intended to be called from inside a
 * `db.transaction(async (tx) => { ... })` block so the INSERT atomic-
 * ally joins the state change that triggered it.
 *
 * Returns the new event id for observability — the caller can log it
 * to trace the eventual dispatch.
 *
 * Dev-mode post-commit drain: the `register()` hook in
 * `instrumentation.ts` skips ALL pg-boss workers when
 * `NODE_ENV !== 'production'` to keep local `next dev` lightweight.
 * Without intervention that also disables the security-events worker,
 * so an event emitted in dev would just sit in the outbox forever:
 * no audit row, no notification email, broken test path. Schedule a
 * short-delayed inline drain via `setTimeout` — the delay is enough
 * for the caller's transaction to commit, after which the drain
 * reads the row through a fresh DB handle and runs the registered
 * subscribers. Prod leaves this alone and relies on the scheduled
 * worker.
 */
export async function emitSecurityEvent(
  input: EmitSecurityEventInput,
): Promise<string> {
  const payloadJson = JSON.stringify(input.payload ?? {});
  const version = input.eventVersion ?? 1;

  const result = await input.db.execute<{ id: string }>(
    sql`INSERT INTO security_events_outbox
          (event_type, event_version, subject_kind, subject_id,
           payload, emitted_at, attempts)
        VALUES
          (${input.eventType}, ${version}, ${input.subject.kind},
           ${input.subject.id}, ${payloadJson}::jsonb,
           ${input.now.toISOString()}, 0)
        RETURNING id`,
  );
  const row = result.rows[0] as { id: string } | undefined;
  if (row === undefined) {
    throw new Error('security_events_outbox INSERT returned no row — this should be impossible.');
  }

  // Dev-mode inline drain. No-op in production.
  scheduleDevInlineDrain();

  return row.id;
}

// ---------- Dev-mode drain (not called in production) ----------

let devSubscribersBootstrapped = false;

/**
 * Dev-only outbox drain. Schedules a fire-and-forget dispatch 150ms
 * after the current call site — enough slack for the caller's
 * `db.transaction(...)` to commit before the drain's fresh DB handle
 * tries to SELECT the row. A production deployment runs the proper
 * pg-boss worker and never hits this path.
 */
function scheduleDevInlineDrain(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  setTimeout(() => {
    void (async () => {
      try {
        // Dynamic imports to avoid circular-dep hazards with
        // dispatcher.ts / bootstrap.ts and to keep the prod bundle
        // free of the drain code path.
        const { getDatabaseClient } = await import('@/lib/db/client');
        const { dispatchPendingSecurityEvents } = await import('./dispatcher');
        const { bootstrapSecurityEventSubscribers } = await import('./bootstrap');
        if (!devSubscribersBootstrapped) {
          bootstrapSecurityEventSubscribers();
          devSubscribersBootstrapped = true;
        }
        await dispatchPendingSecurityEvents({
          db: getDatabaseClient().db,
          now: new Date(),
          batchSize: 10,
        });
      } catch (err) {
        // Dev mode — swallow + log so one broken endpoint does not
        // blow up every future emit.
        getRootLogger().warn(
          {
            event: 'security_events_dev_drain_failed',
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          },
          'security-events dev-drain failed',
        );
      }
    })();
  }, 150);
}
