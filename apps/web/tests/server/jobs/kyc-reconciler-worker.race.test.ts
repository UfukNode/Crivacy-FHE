// @vitest-environment node
/**
 * Race-condition + cycle-resilience tests for the KYC reconciler.
 *
 * The reconciler is a periodic worker that runs concurrently with the
 * Didit webhook handler + the SSE pull-fallback. Three race surfaces
 * exist:
 *
 *   1. Reconciler + webhook both detect the same Approved session and
 *      both enqueue. pg-boss `singletonKey` (set inside
 *      `enqueueCredentialPipeline`) collapses to one job — verified
 *      structurally here by asserting the reconciler ALWAYS goes
 *      through the canonical helper.
 *
 *   2. Reconciler picks up a customer mid-cycle who is then admin-reset
 *      (revoked_at flipped). The drift query filters by
 *      `revoked_at IS NULL` so the next cycle excludes them; an
 *      in-flight customer's Approved enqueue still hits the
 *      pipeline's own `customers.status` + Phase 1 pre-check guards
 *      (verified by the credential-pipeline test suite). The
 *      reconciler is correct as long as it does not bypass those
 *      guards — verified here by asserting it never touches Chain /
 *      DB credentials directly, only calls `enqueueCredentialPipeline`.
 *
 *   3. One customer's reconcile throws → `runReconciliationCycle`
 *      catches + audits and continues with the next customer. A
 *      single bad row cannot abort the whole sweep.
 *
 * Multi-replica concurrency (only one cycle per cron tick across N
 * instances) is enforced by pg-boss's advisory lock around the
 * scheduled job — that's library-internal and covered by pg-boss's
 * own test suite. We pin the reconciler's contract instead: it relies
 * on `boss.schedule` rather than rolling its own clock-driver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@crivacy-fhe/adapter-didit/config', () => ({
  getDiditConfig: vi.fn(() => ({
    webhookSecret: 'fixture-secret',
    webhookDriftSeconds: 300,
    apiBaseUrl: 'https://didit.test',
    apiKey: 'fixture-api-key',
  })),
}));

// `vi.hoisted` keeps the mock spy declarations valid inside vi.mock
// factories (which are hoisted above top-level const declarations).
interface PipelineJobShape {
  readonly kycSessionId: string;
  readonly customerId: string;
  readonly diditSessionId: string;
  readonly phase: 'identity' | 'address';
}
const { getDecisionMock, enqueueCredentialPipelineMock, writeAuditMock } = vi.hoisted(() => ({
  getDecisionMock: vi.fn<
    (
      config: unknown,
      sessionId: string,
    ) => Promise<{ status: string; sessionId?: string; workflowType?: 'kyc' | 'address' }>
  >(),
  enqueueCredentialPipelineMock: vi.fn<
    (boss: unknown, job: PipelineJobShape) => Promise<string | null>
  >(),
  writeAuditMock: vi.fn<(db: unknown, input: { action: string }) => Promise<undefined>>(),
}));

vi.mock('@crivacy-fhe/adapter-didit/session', () => ({
  getDecision: getDecisionMock,
}));

vi.mock('@crivacy-fhe/adapter-didit/types', () => ({
  asDiditSessionIdUnchecked: vi.fn((s: string) => s),
  DIDIT_STATUS: Object.freeze({
    NOT_STARTED: 'Not Started',
    IN_PROGRESS: 'In Progress',
    IN_REVIEW: 'In Review',
    RESUBMITTED: 'Resubmitted',
    APPROVED: 'Approved',
    DECLINED: 'Declined',
    EXPIRED: 'Expired',
    ABANDONED: 'Abandoned',
    KYC_EXPIRED: 'Kyc Expired',
  }),
}));

vi.mock('@/server/jobs/credential-pipeline-worker', () => ({
  CREDENTIAL_PIPELINE_QUEUE: 'credential-pipeline',
  enqueueCredentialPipeline: enqueueCredentialPipelineMock,
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: writeAuditMock,
}));

import {
  reconcileCustomer,
  runReconciliationCycle,
} from '@/server/jobs/kyc-reconciler-worker';

const SESSION_FIXTURE = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222',
  workflow: 'identity' as const,
  status: 'in_progress' as const,
  diditSessionId: 'didit-abc',
  diditWorkflowId: 'workflow-uuid',
  diditDecisionPayload: null,
  resubmissionInfo: null,
  verificationUrl: 'https://didit.test/v/123',
  returnUrl: null,
  failureReason: null,
  attempts: 0,
  startedAt: new Date('2026-05-08T10:00:00Z'),
  completedAt: null,
  expiresAt: new Date('2026-05-09T10:00:00Z'),
  createdAt: new Date('2026-05-08T10:00:00Z'),
  updatedAt: new Date('2026-05-08T10:00:00Z'),
});

interface DbStub {
  selectQueue: Array<readonly Record<string, unknown>[]>;
  updateCalls: Array<{ table: string; set: Record<string, unknown> }>;
  executeQueue: Array<{ rows: readonly Record<string, unknown>[] }>;
}

function buildDb(stub: DbStub): unknown {
  let selectIdx = 0;
  let executeIdx = 0;
  const fluent = (rows: readonly Record<string, unknown>[]) => ({
    from: () => fluent(rows),
    where: () => fluent(rows),
    orderBy: () => fluent(rows),
    limit: async () => rows,
  });
  return {
    select: () => {
      const rows = stub.selectQueue[selectIdx] ?? [];
      selectIdx += 1;
      return fluent(rows);
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          stub.updateCalls.push({ table: 'unknown', set: values });
          return { rowCount: 1 };
        },
      }),
    }),
    execute: async () => {
      const rows = stub.executeQueue[executeIdx] ?? { rows: [] };
      executeIdx += 1;
      return rows;
    },
  };
}

const NOOP_LOGGER = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Race surface 1 — reconciler routes through the pipeline's own dedupe.
// ---------------------------------------------------------------------------

describe('reconciler dedupe contract', () => {
  it('NEVER calls Chain or pg-boss directly — always via enqueueCredentialPipeline', async () => {
    // The reconciler's promise of safety under webhook concurrency
    // depends on it inheriting `enqueueCredentialPipeline`'s
    // singletonKey + retryLimit + retryBackoff defaults, NOT on
    // rolling its own boss.send call. This test pins that contract.
    const db = buildDb({
      selectQueue: [[SESSION_FIXTURE]],
      updateCalls: [],
      executeQueue: [],
    });
    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' });

    // Pass a `boss` that throws if anything other than
    // enqueueCredentialPipeline (which is mocked) tries to use it.
    const trapBoss = new Proxy(
      {},
      {
        get: () => {
          throw new Error('reconciler must not poke boss directly');
        },
      },
    );

    await reconcileCustomer(
      {
        db: db as never,
        boss: trapBoss as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: {
          increment: () => undefined,
          reset: () => undefined,
          current: () => 0,
        },
        now: new Date('2026-05-08T12:00:00Z'),
      },
      SESSION_FIXTURE.customerId,
    );

    // Only enqueueCredentialPipeline got invoked — and trapBoss
    // never received any property access, proving the helper is
    // the sole pg-boss surface from the reconciler.
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Race surface 2 — already covered: the drift query filters
// revoked_at IS NULL + deleted_at IS NULL at the SQL layer (the
// integration test pins that). reconcileCustomer itself does not need
// a redundant in-memory check.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Race surface 3 — runReconciliationCycle continues past a per-row throw.
// ---------------------------------------------------------------------------

describe('runReconciliationCycle resilience', () => {
  it('disabled config short-circuits with no candidates scanned', async () => {
    const result = await runReconciliationCycle({
      db: {} as never,
      boss: {} as never,
      logger: NOOP_LOGGER,
      config: Object.freeze({
        lookbackHours: 168,
        maxPerCycle: 100,
        throttleMs: 500,
        cron: '*/15 * * * *',
        disabled: true,
      }),
    });

    expect(result.scanned).toBe(0);
    expect(result.outcomes).toEqual([]);
    // No DB read attempt — tests would crash if it tried since db is `{}`.
  });

  it('continues past a per-row throw and audits the failure', async () => {
    // Build a stub that returns 2 candidates from execute(), and 1
    // session row + then 1 throwing session for the second customer.
    const customer1 = '11111111-1111-4111-8111-111111111111';
    const customer2 = '22222222-2222-4222-8222-222222222222';

    const stub = {
      selectQueue: [
        [SESSION_FIXTURE], // findLatestKycSession for customer1
        [{ ...SESSION_FIXTURE, customerId: customer2 }], // for customer2
      ] as Array<readonly Record<string, unknown>[]>,
      updateCalls: [] as Array<{ table: string; set: Record<string, unknown> }>,
      executeQueue: [
        {
          rows: [
            { customer_id: customer1, started_at: '2026-05-08T11:00:00Z' },
            { customer_id: customer2, started_at: '2026-05-08T10:30:00Z' },
          ],
        },
      ],
    };

    const db = buildDb(stub);

    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' }); // customer1 OK
    getDecisionMock.mockRejectedValueOnce(new Error('boom')); // customer2 throws

    const result = await runReconciliationCycle({
      db: db as never,
      boss: {} as never,
      logger: NOOP_LOGGER,
      config: Object.freeze({
        lookbackHours: 168,
        maxPerCycle: 100,
        throttleMs: 500,
        cron: '*/15 * * * *',
        disabled: false,
      }),
    });

    expect(result.scanned).toBe(2);
    // Both customers produced an outcome — the cycle did not abort.
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.kind).toBe('enqueued_pipeline');
    // The second outcome is the resilience marker (didit_transient_error
    // wrapping the per-row throw).
    expect(result.outcomes[1]!.kind).toBe('didit_transient_error');

    // customer1's enqueue went through, customer2 NEVER got an
    // enqueue (its branch threw before the Approved path).
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('returns scanned=0 when drift query yields no candidates', async () => {
    const stub = {
      selectQueue: [],
      updateCalls: [],
      executeQueue: [{ rows: [] }],
    };
    const db = buildDb(stub);

    const result = await runReconciliationCycle({
      db: db as never,
      boss: {} as never,
      logger: NOOP_LOGGER,
      config: Object.freeze({
        lookbackHours: 168,
        maxPerCycle: 100,
        throttleMs: 500,
        cron: '*/15 * * * *',
        disabled: false,
      }),
    });

    expect(result.scanned).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(getDecisionMock).not.toHaveBeenCalled();
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
  });
});
