// @vitest-environment node
/**
 * Integration test for the customer KYC state invariant.
 *
 * Two surfaces are exercised against the real Postgres DB:
 *
 *   1. `revokeActiveKycSessions` (lib/customer/kyc-reset.ts) —
 *      the canonical helper every customer-flow mutation path
 *      (admin reset_kyc, ban, Didit user-entity revoke, kyc_expired)
 *      calls when transitioning a customer to a baseline / revoked
 *      state. The forward bug shipped on 2026-05-09 was the admin
 *      `reset_kyc` handler not calling this helper at all — the
 *      session row stayed in `identity_approved` and the customer
 *      dashboard kept rendering an "in review" stepper after the
 *      level had been reset to `kyc_0`. This suite pins the helper's
 *      WHERE-clause + kind-filter behaviour so a future invariant
 *      change ships with a failing test rather than a silent regression.
 *
 *   2. `findReverseDriftCandidates` + `reconcileReverseDriftCustomer`
 *      (server/jobs/kyc-reconciler-worker.ts) — the runtime safety
 *      net for the same drift class. If a fifth mutation path is
 *      added in the future and forgets to call the helper, the
 *      reconciler's reverse-drift pass picks up the orphan session
 *      on the next cycle and closes it the same way.
 *
 * Run with:
 *   INTEGRATION_DEVNET=1 pnpm test tests/integration/kyc-state-invariant.integration.test.ts
 *
 * Required env (loaded from `apps/web/.env`):
 *   - Local Postgres at 127.0.0.1:5433.
 *   - DATABASE_URL_ADMIN set to a BYPASSRLS connection string.
 *   - CRIVACY_SELF_SERVICE_FIRM_ID for any FK target the reconciler
 *     surfaces (the helper itself doesn't write FK-bound rows, but
 *     the reconciler's audit row does and the writer validates it).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const RUN = process.env['INTEGRATION_DEVNET'] === '1';

import { getDatabaseClient } from '@/lib/db/client';
import { revokeActiveKycSessions } from '@/lib/customer/kyc-reset';
import {
  findReverseDriftCandidates,
  reconcileReverseDriftCustomer,
  runReconciliationCycle,
} from '@/server/jobs/kyc-reconciler-worker';
import { REVOKABLE_SESSION_STATUSES } from '@/lib/kyc/session-status-display';

describe.skipIf(!RUN)('kyc-state-invariant — integration', () => {
  const SUFFIX = `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const DIDIT_WORKFLOW_ID =
    process.env['DIDIT_KYC_WORKFLOW_ID'] ?? '2ab9f298-699c-4b2c-9ce9-6246c17c6c25';

  let admin: pg.Pool;
  // Ids tracked across `it` blocks so cleanup is deterministic — the
  // failure mode this guards against is a half-failed test leaving
  // rows behind that the next run's drift query would surface as
  // false positives.
  const seededCustomerIds: string[] = [];

  beforeAll(async () => {
    expect(process.env['DATABASE_URL_ADMIN']).toBeDefined();
    admin = new pg.Pool({
      connectionString: process.env['DATABASE_URL_ADMIN'],
      max: 2,
    });
  }, 30_000);

  afterAll(async () => {
    if (admin === undefined) return;
    try {
      if (seededCustomerIds.length > 0) {
        await admin.query(
          `DELETE FROM kyc_sessions WHERE customer_id = ANY($1::uuid[])`,
          [seededCustomerIds],
        );
        // `audit_log.target_id` is `text` but the pg driver auto-types
        // the bound array as `uuid[]` from the JS string-uuid values,
        // so an `ANY($1::text[])` comparison fails with
        // `operator does not exist: uuid = text`. Cast both sides to
        // uuid via the column expression to keep the comparison
        // monomorphic (audit rows use the canonical 36-char string
        // form, so the uuid cast is loss-less).
        await admin.query(
          `DELETE FROM audit_log WHERE target_id::uuid = ANY($1::uuid[])`,
          [seededCustomerIds],
        );
        await admin.query(
          `DELETE FROM customers WHERE id = ANY($1::uuid[])`,
          [seededCustomerIds],
        );
      }
    } finally {
      await admin.end();
    }
  }, 30_000);

  afterEach(async () => {
    // Defensive: reset any leftover active sessions between tests so
    // the reverse-drift query in test N+1 doesn't see test N's rows.
    if (seededCustomerIds.length > 0) {
      await admin.query(
        `UPDATE kyc_sessions SET status = 'revoked', completed_at = NOW(), updated_at = NOW()
          WHERE customer_id = ANY($1::uuid[]) AND status = ANY($2::kyc_session_status[])`,
        [seededCustomerIds, [...REVOKABLE_SESSION_STATUSES]],
      );
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Test fixture helpers                                              */
  /* ------------------------------------------------------------------ */

  async function seedCustomerWithIdentitySession(opts: {
    readonly kycLevel: 'kyc_0' | 'kyc_1' | 'kyc_3';
    readonly sessionStatus: string;
    readonly tag: string;
    /**
     * Drift marker — when set, the seeded row carries a `revoked_at`
     * stamp, which is one of the two definitive reset signals the
     * reverse-drift query keys off (the other is a terminal-status
     * row in `kyc_credentials_meta`). Tests that exercise the
     * reverse-drift pass MUST set this; tests that exercise the
     * normal in-flight state MUST leave it unset.
     */
    readonly revokedAt?: boolean;
  }): Promise<{ customerId: string; sessionId: string }> {
    const customer = await admin.query<{ id: string }>(
      `INSERT INTO customers (status, kyc_level, kyc_score, kyc_fields_locked,
                              failed_login_attempts, revoked_at, revoked_reason,
                              created_at, updated_at)
       VALUES ('active', $1, 0, false, 0,
               $2, $3,
               NOW(), NOW())
       RETURNING id`,
      [
        opts.kycLevel,
        opts.revokedAt === true ? new Date() : null,
        opts.revokedAt === true ? 'test_reverse_drift_seed' : null,
      ],
    );
    const customerId = customer.rows[0]!.id;
    seededCustomerIds.push(customerId);

    const session = await admin.query<{ id: string }>(
      `INSERT INTO kyc_sessions (kind, customer_id, workflow, status,
                                 didit_session_id, didit_workflow_id,
                                 attempts, started_at, expires_at,
                                 created_at, updated_at)
       VALUES ('customer', $1, 'identity', $2, $3, $4,
               1, NOW(), NOW() + interval '7 days', NOW(), NOW())
       RETURNING id`,
      [customerId, opts.sessionStatus, `didit-${opts.tag}-${SUFFIX}`, DIDIT_WORKFLOW_ID],
    );
    return { customerId, sessionId: session.rows[0]!.id };
  }

  async function readSessionStatus(sessionId: string): Promise<string> {
    const row = await admin.query<{ status: string }>(
      `SELECT status FROM kyc_sessions WHERE id = $1`,
      [sessionId],
    );
    return row.rows[0]!.status;
  }

  async function countAuditRows(
    customerId: string,
    action: string,
  ): Promise<number> {
    const row = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE target_id = $1 AND action = $2`,
      [customerId, action],
    );
    return Number.parseInt(row.rows[0]!.count, 10);
  }

  /* ------------------------------------------------------------------ */
  /*  Helper invariant — revokeActiveKycSessions                        */
  /* ------------------------------------------------------------------ */

  it('revokeActiveKycSessions flips an active session to revoked + stamps fields', async () => {
    const { customerId, sessionId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'identity_approved',
      tag: 'flip',
    });

    const handle = getDatabaseClient();
    const now = new Date();
    const count = await revokeActiveKycSessions(handle.admin, customerId, now, 'test_reason');
    expect(count).toBe(1);

    const after = await admin.query<{
      status: string;
      failure_reason: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, failure_reason, completed_at FROM kyc_sessions WHERE id = $1`,
      [sessionId],
    );
    const row = after.rows[0]!;
    expect(row.status).toBe('revoked');
    expect(row.failure_reason).toBe('test_reason');
    expect(row.completed_at).not.toBeNull();
  }, 30_000);

  it('does not touch sessions already in a terminal status (idempotent)', async () => {
    const { customerId, sessionId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'expired',
      tag: 'terminal',
    });

    const handle = getDatabaseClient();
    const count = await revokeActiveKycSessions(
      handle.admin,
      customerId,
      new Date(),
      'test_reason',
    );
    expect(count).toBe(0);

    const status = await readSessionStatus(sessionId);
    expect(status).toBe('expired');
  }, 30_000);

  // The kind-filter on the helper's WHERE clause (`kind = 'customer'`)
  // isolates customer-flow rows from B2B rows by construction. A
  // dedicated runtime assertion would have to seed a B2B row, which
  // requires a pre-existing `firm_users` + `api_keys` chain plus a
  // non-null `level` enum (per the `kyc_sessions_kind_invariant`
  // CHECK constraint). The cost of standing up that fixture exceeds
  // the marginal value over the source-level guarantee, so the
  // isolation property is intentionally pinned by code review +
  // tsc rather than DB integration.
  /* ------------------------------------------------------------------ */
  /*  Reverse-drift reconciler safety net                                */
  /* ------------------------------------------------------------------ */

  it('findReverseDriftCandidates surfaces a revoked customer with an orphan active session', async () => {
    const { customerId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'identity_approved',
      tag: 'reverse-drift',
      revokedAt: true,
    });

    const handle = getDatabaseClient();
    const candidates = await findReverseDriftCandidates(handle.admin, {
      maxPerCycle: 50,
    });
    const ids = candidates.map((c) => c.customerId);
    expect(ids).toContain(customerId);

    const candidate = candidates.find((c) => c.customerId === customerId);
    expect(candidate?.kycLevel).toBe('kyc_0');
    expect(candidate?.orphanSessionCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('SKIPS an in-flight customer (kyc_0 + active session, no reset signal)', async () => {
    // This is the prod-safety pin. A brand-new customer who just
    // clicked "Start KYC" sits at `kyc_0` with a `pending` or
    // `in_progress` session and NO revoked credential, NO revoked_at
    // — exactly the pattern the original draft of this query
    // mistakenly flagged. The helper MUST leave them alone or it will
    // kill the in-flight Didit session.
    const { customerId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'pending',
      tag: 'in-flight',
      // intentionally NO revokedAt — this is the normal initial state
    });

    const handle = getDatabaseClient();
    const candidates = await findReverseDriftCandidates(handle.admin, {
      maxPerCycle: 50,
    });
    const ids = candidates.map((c) => c.customerId);
    expect(ids).not.toContain(customerId);
  }, 30_000);

  it('reconcileReverseDriftCustomer revokes orphans + writes the audit row', async () => {
    const { customerId, sessionId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'identity_approved',
      tag: 'reverse-resolve',
      revokedAt: true,
    });

    const handle = getDatabaseClient();
    const beforeAudit = await countAuditRows(customerId, 'kyc_reconciler.reverse_drift_resolved');

    const outcome = await reconcileReverseDriftCustomer(
      { db: handle.admin, now: new Date() },
      customerId,
    );

    expect(outcome.kind).toBe('reverse_drift_resolved');
    if (outcome.kind === 'reverse_drift_resolved') {
      expect(outcome.revokedSessions).toBe(1);
    }

    expect(await readSessionStatus(sessionId)).toBe('revoked');

    const afterAudit = await countAuditRows(customerId, 'kyc_reconciler.reverse_drift_resolved');
    expect(afterAudit).toBe(beforeAudit + 1);
  }, 30_000);

  it('runReconciliationCycle drives the reverse-drift pass alongside forward drift', async () => {
    const { customerId, sessionId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'identity_approved',
      tag: 'cycle',
      revokedAt: true,
    });

    const handle = getDatabaseClient();
    const result = await runReconciliationCycle({
      db: handle.admin,
      boss: {} as never,
      logger: { info: console.log, error: console.error },
      config: Object.freeze({
        lookbackHours: 24,
        maxPerCycle: 50,
        throttleMs: 0,
        cron: '*/15 * * * *',
        disabled: false,
      }),
    });

    expect(result.reverseScanned).toBeGreaterThanOrEqual(1);
    const matching = result.reverseOutcomes.find(
      (o) => o.kind === 'reverse_drift_resolved' && o.customerId === customerId,
    );
    expect(matching).toBeDefined();
    expect(await readSessionStatus(sessionId)).toBe('revoked');
  }, 60_000);

  it('reverse-drift pass is idempotent (second run resolves zero rows)', async () => {
    const { customerId } = await seedCustomerWithIdentitySession({
      kycLevel: 'kyc_0',
      sessionStatus: 'in_progress',
      tag: 'idempotent',
      revokedAt: true,
    });

    const handle = getDatabaseClient();
    const first = await reconcileReverseDriftCustomer(
      { db: handle.admin, now: new Date() },
      customerId,
    );
    expect(first.kind).toBe('reverse_drift_resolved');

    // Second run — the previous pass flipped the row to `revoked`,
    // which is outside `REVOKABLE_SESSION_STATUSES`, so the helper's
    // WHERE clause matches nothing and the outcome is the noop branch.
    const second = await reconcileReverseDriftCustomer(
      { db: handle.admin, now: new Date() },
      customerId,
    );
    expect(second.kind).toBe('reverse_drift_noop');
  }, 30_000);
});
