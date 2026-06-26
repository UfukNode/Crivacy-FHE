// @vitest-environment node
/**
 * Integration test for the KYC reconciler against the real Postgres
 * database. Mocks ONLY the Didit `getDecision` HTTP call (covered by
 * unit tests; reaching the real Didit sandbox from CI is brittle) and
 * `enqueueCredentialPipeline` (the pipeline itself is integration-
 * tested separately by `credential-pipeline-devnet.integration.test`).
 *
 * Every other layer runs for real:
 *
 *   * Drizzle DB writes (customer + customer_kyc_session)
 *   * Audit-log INSERT for `customer.kyc_started` (the reconciler's
 *     drift query reads from `audit_log` directly via raw SQL).
 *   * The reconciler's drift query + reconcileCustomer pipeline.
 *   * The audit-log INSERT for `kyc_reconciler.drift_resolved`.
 *
 * Run with:
 *   INTEGRATION_DEVNET=1 pnpm test tests/integration/kyc-reconciler.integration.test.ts
 *
 * Required env (loaded from `apps/web/.env`):
 *   - Local Postgres at 127.0.0.1:5433.
 *   - DATABASE_URL_ADMIN set to a BYPASSRLS connection string.
 *   - CRIVACY_SELF_SERVICE_FIRM_ID (FK target for credential rows the
 *     reconciler is meant to surface).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const RUN = process.env['INTEGRATION_DEVNET'] === '1';

/* ---------- Mocks: Didit getDecision + pipeline enqueue ---------- */

interface PipelineJobShape {
  readonly kycSessionId: string;
  readonly customerId: string;
  readonly diditSessionId: string;
  readonly phase: 'identity' | 'address';
}
const { getDecisionMock, enqueueCredentialPipelineMock } = vi.hoisted(() => ({
  getDecisionMock: vi.fn<
    (
      config: unknown,
      sessionId: string,
    ) => Promise<{ status: string; sessionId?: string; workflowType?: 'kyc' | 'address' }>
  >(),
  enqueueCredentialPipelineMock: vi.fn<
    (boss: unknown, job: PipelineJobShape) => Promise<string | null>
  >(),
}));

vi.mock('@crivacy-fhe/adapter-didit/session', () => ({
  getDecision: getDecisionMock,
}));
vi.mock('@/server/jobs/credential-pipeline-worker', () => ({
  CREDENTIAL_PIPELINE_QUEUE: 'credential-pipeline',
  enqueueCredentialPipeline: enqueueCredentialPipelineMock,
}));

/* ---------- Imports AFTER mocks ---------- */

import { getDatabaseClient } from '@/lib/db/client';
import {
  findDriftCandidates,
  reconcileCustomer,
  runReconciliationCycle,
  createNoopFailureStreakCounter,
  buildThrottle,
} from '@/server/jobs/kyc-reconciler-worker';

/* ---------- Suite ---------- */

describe.skipIf(!RUN)('kyc-reconciler — integration', () => {
  const SUFFIX = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const SELF_SERVICE_FIRM_ID = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'] ?? '';

  let admin: pg.Pool;
  let customerId: string;
  let kycSessionId: string;

  beforeAll(async () => {
    expect(SELF_SERVICE_FIRM_ID, 'CRIVACY_SELF_SERVICE_FIRM_ID must be set').not.toBe('');
    expect(process.env['DATABASE_URL_ADMIN']).toBeDefined();

    admin = new pg.Pool({
      connectionString: process.env['DATABASE_URL_ADMIN'],
      max: 2,
    });

    // Insert a kyc_0 customer and a customer_kyc_session row in
    // `pending` state — exactly the shape Sprint 3's drift query
    // looks for (`customer.kyc_started` audit + no completion event +
    // no active credential row).
    const customer = await admin.query<{ id: string }>(
      `INSERT INTO customers (status, kyc_level, kyc_score, kyc_fields_locked,
                              failed_login_attempts, created_at, updated_at)
       VALUES ('active', 'kyc_0', 0, false, 0, NOW(), NOW())
       RETURNING id`,
    );
    customerId = customer.rows[0]!.id;

    // Sprint 7 — `customer_kyc_sessions` was dropped in Phase H; the
    // unified `kyc_sessions` table holds both kinds with a `kind`
    // discriminator column.
    const session = await admin.query<{ id: string }>(
      `INSERT INTO kyc_sessions (kind, customer_id, workflow, status,
                                 didit_session_id, didit_workflow_id,
                                 attempts, started_at, expires_at,
                                 created_at, updated_at)
       VALUES ('customer', $1, 'identity', 'in_progress', $2, $3,
               1, NOW(), NOW() + interval '7 days', NOW(), NOW())
       RETURNING id`,
      [
        customerId,
        `didit-int-${SUFFIX}`,
        process.env['DIDIT_KYC_WORKFLOW_ID'] ?? '2ab9f298-699c-4b2c-9ce9-6246c17c6c25',
      ],
    );
    kycSessionId = session.rows[0]!.id;

    // Synthesize the customer.kyc_started audit row that
    // findDriftCandidates uses as the seed signal. The actor /
    // target validators run for real here.
    await admin.query(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id,
                              action, target_kind, target_id, target_ref,
                              ip, user_agent, request_id, meta, ts)
       VALUES ('customer', $1, 'integration-test', NULL,
               'customer.kyc_started', 'customer', $1, NULL,
               NULL, NULL, NULL, '{}'::jsonb, NOW())`,
      [customerId],
    );
  }, 30_000);

  afterAll(async () => {
    if (admin === undefined) return;
    try {
      await admin.query(
        `DELETE FROM kyc_sessions WHERE kind = 'customer' AND customer_id = $1`,
        [customerId],
      );
      await admin.query('DELETE FROM audit_log WHERE target_id = $1', [customerId]);
      await admin.query('DELETE FROM customers WHERE id = $1', [customerId]);
    } finally {
      await admin.end();
    }
  }, 30_000);

  beforeEach(() => {
    getDecisionMock.mockReset();
    enqueueCredentialPipelineMock.mockClear();
  });

  it('findDriftCandidates surfaces the drift customer + filters admin-revoked', async () => {
    const handle = getDatabaseClient();
    const candidates = await findDriftCandidates(handle.admin, {
      lookbackHours: 24,
      maxPerCycle: 50,
    });
    const ids = candidates.map((c) => c.customerId);
    expect(ids).toContain(customerId);

    // Flip revoked_at and assert the drift query now excludes them.
    await admin.query(
      `UPDATE customers SET revoked_at = NOW(), revoked_reason = 'didit_user_blocked'
        WHERE id = $1`,
      [customerId],
    );
    try {
      const filtered = await findDriftCandidates(handle.admin, {
        lookbackHours: 24,
        maxPerCycle: 50,
      });
      expect(filtered.map((c) => c.customerId)).not.toContain(customerId);
    } finally {
      await admin.query(`UPDATE customers SET revoked_at = NULL WHERE id = $1`, [customerId]);
    }
  }, 30_000);

  it('reconcileCustomer Approved → enqueues + writes drift_resolved audit row', async () => {
    getDecisionMock.mockResolvedValueOnce({
      sessionId: `didit-int-${SUFFIX}`,
      status: 'Approved',
      workflowType: 'kyc' as const,
    });

    const handle = getDatabaseClient();
    const beforeRows = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log
        WHERE target_id = $1 AND action = 'kyc_reconciler.drift_resolved'`,
      [customerId],
    );
    const beforeCount = Number.parseInt(beforeRows.rows[0]!.count, 10);

    const outcome = await reconcileCustomer(
      {
        db: handle.admin,
        boss: {} as never,
        logger: { info: console.log, error: console.error },
        throttle: buildThrottle(0),
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date(),
      },
      customerId,
    );

    expect(outcome.kind).toBe('enqueued_pipeline');
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    expect(enqueueCredentialPipelineMock.mock.calls[0]![1]).toMatchObject({
      kycSessionId,
      customerId,
      phase: 'identity',
    });

    const afterRows = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log
        WHERE target_id = $1 AND action = 'kyc_reconciler.drift_resolved'`,
      [customerId],
    );
    const afterCount = Number.parseInt(afterRows.rows[0]!.count, 10);
    expect(afterCount).toBe(beforeCount + 1);
  }, 30_000);

  it('runReconciliationCycle picks the drift up + drives reconcileCustomer per row', async () => {
    getDecisionMock.mockResolvedValueOnce({
      sessionId: `didit-int-${SUFFIX}`,
      status: 'Approved',
      workflowType: 'kyc' as const,
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

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    // The drift customer's outcome MUST be in the cycle's outcomes.
    const matchingOutcome = result.outcomes.find(
      (o) => o.kind === 'enqueued_pipeline',
    );
    expect(matchingOutcome).toBeDefined();
  }, 60_000);
});
