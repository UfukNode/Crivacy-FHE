// @vitest-environment node
/**
 * Unit tests for the KYC reconciler worker. Covers:
 *
 *   * `buildThrottle` — minimum interval + first-call-no-wait + jitter range
 *   * `createFailureStreakCounter` — alert at threshold + reset on non-401
 *   * `reconcileCustomer` — every routing branch:
 *       - Approved → enqueues pipeline + audit drift_resolved
 *       - Declined / Expired / Kyc Expired → updates session + audit drift_resolved
 *       - In Review / Resubmitted (pending) → no DB write + audit drift_detected
 *       - unknown Didit status → no DB write + audit drift_detected
 *       - Didit not_found (404) → marks session expired + audit drift_detected
 *       - Didit unauthorized (401) → increments streak + audit + no enqueue
 *       - Didit transient 5xx / network → audit drift_detected, no DB write
 *       - no session for customer → audit drift_detected, no Didit GET
 *       - terminal session in DB (rejected/expired) → short-circuits + audit
 *       - Phase 2 without active Phase 1 → phase2_missing_phase1_prereq audit
 *
 * Race / regression coverage:
 *
 *   * `enqueueCredentialPipeline` is invoked with the SAME singletonKey
 *     a webhook would use (`kycSessionId:phase`), so the pipeline's
 *     dedupe absorbs concurrent webhook + reconciler enqueue.
 *
 * The DB stub is hand-built (no real Postgres) — same pattern used
 * by `credential-pipeline-worker.test.ts`. The test queues the rows
 * each builder chain returns and the assertions read what was sent
 * to the mock spies for `enqueue` / `writeAudit` / `db.update`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks -----------------------------------------------------------

vi.mock('@crivacy-fhe/adapter-didit/config', () => ({
  getDiditConfig: vi.fn(() => ({
    webhookSecret: 'fixture-secret',
    webhookDriftSeconds: 300,
    apiBaseUrl: 'https://didit.test',
    apiKey: 'fixture-api-key',
  })),
}));

// `vi.mock` factories are hoisted to the top of the file by vitest
// BEFORE top-level const declarations run; referencing a const'd
// `vi.fn(...)` directly in the factory hits TDZ. `vi.hoisted` lifts
// the mock spy declarations together with the mock so the factory
// can read them safely.
interface PipelineJobShape {
  readonly kycSessionId: string;
  readonly customerId: string;
  readonly diditSessionId: string;
  readonly phase: 'identity' | 'address';
}
interface WriteAuditArg {
  readonly action: string;
  readonly actor: { kind: string; label: string };
  readonly target: { kind: string; id?: string };
  readonly meta?: Record<string, unknown>;
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
  writeAuditMock: vi.fn<(db: unknown, input: WriteAuditArg) => Promise<undefined>>(),
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

// systemActor / uuidTarget are pure constructors — keep them real so
// any actor / target validation drift breaks the test loudly.

// Imports AFTER mocks for vi.mock hoisting.
import {
  buildThrottle,
  createFailureStreakCounter,
  createNoopFailureStreakCounter,
  findStuckMintCandidates,
  reconcileCustomer,
  reconcileStuckMint,
  type StuckMintCandidate,
} from '@/server/jobs/kyc-reconciler-worker';
import { DiditError } from '@crivacy-fhe/adapter-didit/errors';

// ---------------------------------------------------------------------------

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

const PHASE1_CRED_FIXTURE = Object.freeze({
  id: '33333333-3333-4333-8333-333333333333',
  status: 'active' as const,
  level: 'basic' as const,
  validator: 'didit' as const,
});

const CUSTOMER_ID = SESSION_FIXTURE.customerId;

// ---------------------------------------------------------------------------

interface DbStub {
  selectQueue: Array<readonly Record<string, unknown>[]>;
  updateCalls: Array<{
    table: string;
    set: Record<string, unknown>;
  }>;
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
    update: (table: { _: { name: string } } | { Symbol?: unknown }) => ({
      set: (values: Record<string, unknown>) => ({
        where: (..._whereArgs: unknown[]) => {
          // Capture the table name from the first key of the symbol-keyed
          // drizzle metadata when present; otherwise fall back to a
          // generic identifier — tests assert structurally on `.set`.
          const tableName =
            (table as { _: { name?: string } } | undefined)?._?.name ?? 'unknown';
          stub.updateCalls.push({ table: tableName, set: values });
          // Drizzle's update().set().where() resolves to a `Promise`-like
          // when awaited directly (legacy callers) AND supports a chained
          // `.returning()` (newer callers). The thenable + method shape
          // covers both: `await db.update(...).set(...).where(...)` works
          // (returns `{ rowCount: 1 }`) and so does
          // `await db.update(...).set(...).where(...).returning(...)`
          // (returns `[{ id: '<stub>' }]`).
          const settled = { rowCount: 1 };
          return {
            then: (resolve: (v: typeof settled) => unknown) => resolve(settled),
            returning: async (_cols: Record<string, unknown>) => [
              // Reconciler's stuck-NFT pass + decline-counter wire only
              // checks `updated.length > 0` semantically; a single stub
              // row keeps the truthy branch alive without coupling tests
              // to the column projection.
              { id: 'stub-id' },
            ],
          };
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

function freshStub(overrides: Partial<DbStub> = {}): DbStub {
  return {
    selectQueue: overrides.selectQueue ?? [],
    updateCalls: overrides.updateCalls ?? [],
    executeQueue: overrides.executeQueue ?? [],
  };
}

const NOOP_LOGGER = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  enqueueCredentialPipelineMock.mockImplementation(async () => 'job-id-123');
  writeAuditMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// buildThrottle
// ---------------------------------------------------------------------------

describe('buildThrottle', () => {
  it('first call does not wait', async () => {
    const sleep = vi.fn(async () => undefined);
    let now = 0;
    const throttle = buildThrottle(500, { clock: () => now, sleep });
    await throttle();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('second call within interval waits', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>();
    sleep.mockImplementation(async () => undefined);
    let now = 0;
    const throttle = buildThrottle(500, { clock: () => now, sleep });
    await throttle();
    now = 100; // 100ms later
    await throttle();
    expect(sleep).toHaveBeenCalledTimes(1);
    const firstCall = sleep.mock.calls[0];
    expect(firstCall).toBeDefined();
    const wait = firstCall![0];
    expect(wait).toBeGreaterThanOrEqual(400); // 500 - 100
    expect(wait).toBeLessThan(500 + 100); // + jitter ceiling
  });

  it('second call after interval does NOT wait', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>();
    sleep.mockImplementation(async () => undefined);
    let now = 0;
    const throttle = buildThrottle(500, { clock: () => now, sleep });
    await throttle();
    now = 700;
    await throttle();
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createFailureStreakCounter
// ---------------------------------------------------------------------------

describe('createFailureStreakCounter', () => {
  it('emits an alert exactly when streak hits the threshold', () => {
    const errSpy = vi.fn();
    const counter = createFailureStreakCounter({ info: vi.fn(), error: errSpy }, 5);
    counter.increment();
    counter.increment();
    counter.increment();
    counter.increment();
    expect(errSpy).not.toHaveBeenCalled();
    counter.increment();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain('threshold hit');
  });

  it('reset clears the streak', () => {
    const errSpy = vi.fn();
    const counter = createFailureStreakCounter({ info: vi.fn(), error: errSpy }, 5);
    counter.increment();
    counter.increment();
    counter.reset();
    expect(counter.current()).toBe(0);
    counter.increment();
    expect(counter.current()).toBe(1);
  });

  it('continues to re-emit at threshold multiples (does not go silent)', () => {
    const errSpy = vi.fn();
    const counter = createFailureStreakCounter({ info: vi.fn(), error: errSpy }, 3);
    counter.increment();
    counter.increment();
    counter.increment(); // first alert at streak=3
    expect(errSpy).toHaveBeenCalledTimes(1);
    counter.increment();
    counter.increment();
    counter.increment(); // second alert at streak=6 (still 401ing)
    expect(errSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// reconcileCustomer
// ---------------------------------------------------------------------------

describe('reconcileCustomer', () => {
  it('Approved → enqueues pipeline with the SAME singletonKey shape webhook uses', async () => {
    const db = buildDb(
      freshStub({
        // 1st select = findLatestKycSession
        selectQueue: [[SESSION_FIXTURE]],
      }),
    );
    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' });

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome).toEqual({
      kind: 'enqueued_pipeline',
      sessionId: SESSION_FIXTURE.id,
      phase: 'identity',
    });
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    expect(enqueueCredentialPipelineMock.mock.calls[0]![1]).toEqual({
      kycSessionId: SESSION_FIXTURE.id,
      customerId: CUSTOMER_ID,
      diditSessionId: SESSION_FIXTURE.diditSessionId,
      phase: 'identity',
    });
    // drift_resolved audit row
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1].action).toBe('kyc_reconciler.drift_resolved');
  });

  it('Declined → updates session row + audits drift_resolved + no enqueue', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'Declined' });

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('session_status_synced');
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    // Two UPDATE calls now: the session row → 'rejected', then the
    // per-customer decline counter bump (lib/fraud/decline-counter.ts).
    // The counter side fires only on `internalStatus === 'rejected'`
    // AND only when the session-row UPDATE matched a row, which the
    // mock's `returning` stub guarantees via `[{ id: 'stub-id' }]`.
    expect(stub.updateCalls).toHaveLength(2);
    expect(stub.updateCalls[0]!.set).toMatchObject({
      status: 'rejected',
      failureReason: 'reconciler_Declined',
    });
    // Decline counter bump — incremented via SQL fragment, last_decline_at
    // stamped to `now`. The fragment value is opaque; assert the field
    // is present so a future refactor that drops the bump fails loudly.
    expect(stub.updateCalls[1]!.set).toHaveProperty('consecutiveKycDeclines');
    expect(stub.updateCalls[1]!.set).toHaveProperty('lastDeclineAt');
    expect(writeAuditMock.mock.calls[0]![1].action).toBe('kyc_reconciler.drift_resolved');
    // The decline-counter audit fires AFTER the drift_resolved row.
    expect(writeAuditMock.mock.calls[1]![1].action).toBe('fraud.kyc_decline_strike');
  });

  it('In Review → audits drift_detected + no DB write + no enqueue', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'In Review' });

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('didit_pending_decision');
    expect(stub.updateCalls).toHaveLength(0);
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock.mock.calls[0]![1].action).toBe('kyc_reconciler.drift_detected');
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      outcome: 'didit_pending_decision',
    });
  });

  it('unknown Didit status → audits + leaves row alone', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'SomeNewDiditStatus' });

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('didit_unknown_status');
    expect(stub.updateCalls).toHaveLength(0);
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      outcome: 'didit_unknown_status',
    });
  });

  it('Didit not_found → marks session expired + audits drift_detected', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockRejectedValueOnce(
      new DiditError('not_found', 'Didit returned 404 for session'),
    );

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('didit_not_found');
    expect(stub.updateCalls).toHaveLength(1);
    expect(stub.updateCalls[0]!.set).toMatchObject({
      status: 'expired',
      failureReason: 'reconciler_didit_not_found',
    });
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
  });

  it('Didit unauthorized → increments streak counter + no enqueue + no DB write', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockRejectedValueOnce(new DiditError('unauthorized', 'Didit returned 401'));
    const errSpy = vi.fn();
    const streak = createFailureStreakCounter({ info: vi.fn(), error: errSpy }, 5);

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: streak,
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('didit_transient_error');
    expect(stub.updateCalls).toHaveLength(0);
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(streak.current()).toBe(1);
  });

  it('Approved on the SAME session by webhook + reconciler concurrently → singletonKey dedupe', async () => {
    // Simulates two concurrent enqueues for the same (kycSessionId, phase).
    // The reconciler always uses the same enqueueCredentialPipeline helper
    // the webhook uses, which builds the singletonKey from
    // `${job.kycSessionId}:${job.phase}`. pg-boss dedupes both jobs
    // to one. Here we assert reconciler does NOT bypass that helper.
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' });

    await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    // The contract: reconciler ALWAYS calls the canonical helper, never
    // pokes pg-boss directly. enqueueCredentialPipeline takes care of
    // singletonKey + retryLimit + retryBackoff, so the reconciler
    // inherits the same dedupe shape webhook + pull-fallback get.
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    expect(enqueueCredentialPipelineMock.mock.calls[0]![1]).toEqual({
      kycSessionId: SESSION_FIXTURE.id,
      customerId: CUSTOMER_ID,
      diditSessionId: SESSION_FIXTURE.diditSessionId,
      phase: 'identity',
    });
  });

  it('5xx / network error → audits drift_detected with errorCode + leaves row alone', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockRejectedValueOnce(
      new DiditError('service_unavailable', 'Didit 503'),
    );

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('didit_transient_error');
    expect(stub.updateCalls).toHaveLength(0);
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      outcome: 'didit_transient_error',
      errorCode: 'service_unavailable',
    });
  });

  it('no session for customer → audits + skips Didit GET entirely', async () => {
    const stub = freshStub({ selectQueue: [[]] });
    const db = buildDb(stub);

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('no_session_found');
    expect(getDecisionMock).not.toHaveBeenCalled();
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('terminal session in DB (rejected) → short-circuits without Didit GET', async () => {
    const stub = freshStub({
      selectQueue: [[{ ...SESSION_FIXTURE, status: 'rejected' }]],
    });
    const db = buildDb(stub);

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('session_already_terminal');
    expect(getDecisionMock).not.toHaveBeenCalled();
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      outcome: 'session_already_terminal',
      internalStatus: 'rejected',
    });
  });

  it('Phase 2 without active Phase 1 credential → audits prereq miss + skips', async () => {
    const stub = freshStub({
      selectQueue: [
        [{ ...SESSION_FIXTURE, workflow: 'address' }], // findLatestKycSession
        [], // findActivePhase1Credential — no active basic credential
      ],
    });
    const db = buildDb(stub);

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome.kind).toBe('phase2_missing_phase1_prereq');
    expect(getDecisionMock).not.toHaveBeenCalled();
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1].action).toBe(
      'kyc_reconciler.phase_address_missing_identity_prereq',
    );
  });

  it('Phase 2 WITH active Phase 1 credential + Approved → enqueues pipeline phase=address', async () => {
    const stub = freshStub({
      selectQueue: [
        [{ ...SESSION_FIXTURE, workflow: 'address' }], // findLatestKycSession
        [PHASE1_CRED_FIXTURE], // findActivePhase1Credential — passes
      ],
    });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' });

    const outcome = await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: async () => undefined,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(outcome).toEqual({
      kind: 'enqueued_pipeline',
      sessionId: SESSION_FIXTURE.id,
      phase: 'address',
    });
    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    expect(enqueueCredentialPipelineMock.mock.calls[0]![1]!.phase).toBe('address');
  });

  it('throttle ALWAYS runs before the Didit GET (defends multi-replica burst)', async () => {
    const stub = freshStub({ selectQueue: [[SESSION_FIXTURE]] });
    const db = buildDb(stub);
    getDecisionMock.mockResolvedValueOnce({ status: 'Approved' });

    const throttleSpy = vi.fn(async () => undefined);

    await reconcileCustomer(
      {
        db: db as never,
        boss: {} as never,
        logger: NOOP_LOGGER,
        throttle: throttleSpy,
        apiKeyFailureStreak: createNoopFailureStreakCounter(),
        now: new Date('2026-05-08T12:00:00Z'),
      },
      CUSTOMER_ID,
    );

    expect(throttleSpy).toHaveBeenCalledTimes(1);
    // Throttle MUST land before getDecision — Didit RPS protection.
    expect(throttleSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      getDecisionMock.mock.invocationCallOrder[0]!,
    );
  });
});

// ---------------------------------------------------------------------------
// findStuckMintCandidates  (Sprint 9 Faz 1.5)
// ---------------------------------------------------------------------------

describe('findStuckMintCandidates — drift query mapping', () => {
  it('maps each row from the raw SQL into a StuckMintCandidate', async () => {
    const stub = freshStub({
      executeQueue: [
        {
          rows: [
            {
              meta_id: 'meta-1',
              firm_id: 'firm-1',
              user_ref: 'user-ref-1',
              kyc_session_id: 'sess-1',
              didit_session_id: 'didit-sess-1',
              session_kind: 'customer',
              customer_id: 'cust-1',
              workflow: 'address',
              meta_created_at: '2026-05-10T10:00:00Z',
            },
            {
              meta_id: 'meta-2',
              firm_id: 'firm-2',
              user_ref: 'b2b-userref-2',
              kyc_session_id: 'sess-2',
              didit_session_id: 'didit-sess-2',
              session_kind: 'b2b',
              customer_id: null,
              workflow: 'identity',
              meta_created_at: '2026-05-10T09:30:00Z',
            },
          ],
        },
      ],
    });
    const db = buildDb(stub);
    const out = await findStuckMintCandidates(db as never, {
      thresholdMs: 30 * 60_000,
      maxPerCycle: 50,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      metaId: 'meta-1',
      sessionKind: 'customer',
      customerId: 'cust-1',
      workflow: 'address',
    });
    expect(out[1]).toMatchObject({
      metaId: 'meta-2',
      sessionKind: 'b2b',
      customerId: null,
      workflow: 'identity',
    });
    // Frozen — caller cannot mutate.
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });

  it('returns an empty frozen array when no rows match', async () => {
    const stub = freshStub({ executeQueue: [{ rows: [] }] });
    const db = buildDb(stub);
    const out = await findStuckMintCandidates(db as never, {
      thresholdMs: 30 * 60_000,
      maxPerCycle: 50,
    });
    expect(out).toHaveLength(0);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileStuckMint  (Sprint 9 Faz 1.5)
// ---------------------------------------------------------------------------

// UUID v4 fixtures — `uuidTarget` validates the id with a v4 regex,
// so non-uuid strings make the audit-writer throw before the
// outcome can be observed.
const META_CUST_ID = '44444444-4444-4444-8444-444444444444';
const SESS_CUST_ID = '55555555-5555-4555-8555-555555555555';
const FIRM_CUST_ID = '66666666-6666-4666-8666-666666666666';
const CUST_ID = '77777777-7777-4777-8777-777777777777';
const META_B2B_ID = '88888888-8888-4888-8888-888888888888';
const SESS_B2B_ID = '99999999-9999-4999-8999-999999999999';
const FIRM_B2B_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const STUCK_CUSTOMER_CANDIDATE: StuckMintCandidate = Object.freeze({
  metaId: META_CUST_ID,
  firmId: FIRM_CUST_ID,
  userRef: CUST_ID,
  kycSessionId: SESS_CUST_ID,
  diditSessionId: 'didit-cust-1',
  sessionKind: 'customer',
  customerId: CUST_ID,
  workflow: 'address',
  metaCreatedAt: new Date('2026-05-10T10:00:00Z'),
});

const STUCK_B2B_CANDIDATE: StuckMintCandidate = Object.freeze({
  metaId: META_B2B_ID,
  firmId: FIRM_B2B_ID,
  userRef: 'b2b-userref-1',
  kycSessionId: SESS_B2B_ID,
  diditSessionId: 'didit-b2b-1',
  sessionKind: 'b2b',
  customerId: null,
  workflow: 'identity',
  metaCreatedAt: new Date('2026-05-10T09:00:00Z'),
});

describe('reconcileStuckMint', () => {
  const NOW = new Date('2026-05-10T11:00:00Z');

  it('customer candidate → enqueues credential pipeline with flow=customer', async () => {
    enqueueCredentialPipelineMock.mockResolvedValueOnce('boss-job-1');
    const stub = freshStub();
    const db = buildDb(stub);
    const outcome = await reconcileStuckMint(
      { db: db as never, boss: {} as never, now: NOW },
      STUCK_CUSTOMER_CANDIDATE,
    );

    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    const job = enqueueCredentialPipelineMock.mock.calls[0]![1];
    expect(job).toMatchObject({
      kycSessionId: SESS_CUST_ID,
      diditSessionId: 'didit-cust-1',
      phase: 'address',
    });
    // Verify flow tag — not on PipelineJobShape narrowed type but
    // present on the call payload.
    expect((job as unknown as Record<string, unknown>)['flow']).toBe('customer');
    expect((job as unknown as Record<string, unknown>)['customerId']).toBe(CUST_ID);

    expect(outcome.kind).toBe('stuck_mint_resolved');
    if (outcome.kind === 'stuck_mint_resolved') {
      expect(outcome.metaId).toBe(META_CUST_ID);
      expect(outcome.bossJobId).toBe('boss-job-1');
    }

    // Audit emitted with stuck_mint_resolved + age telemetry.
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0]![1];
    expect(audit.action).toBe('kyc_reconciler.stuck_mint_resolved');
    expect(audit.target.kind).toBe('credential');
    expect(audit.target.id).toBe(META_CUST_ID);
    expect(audit.meta).toMatchObject({
      flow: 'customer',
      phase: 'address',
      bossJobId: 'boss-job-1',
    });
    expect(audit.meta!['ageMs']).toBe(NOW.getTime() - STUCK_CUSTOMER_CANDIDATE.metaCreatedAt.getTime());
  });

  it('b2b candidate → enqueues credential pipeline with flow=b2b', async () => {
    enqueueCredentialPipelineMock.mockResolvedValueOnce('boss-job-b2b-1');
    const stub = freshStub();
    const db = buildDb(stub);
    const outcome = await reconcileStuckMint(
      { db: db as never, boss: {} as never, now: NOW },
      STUCK_B2B_CANDIDATE,
    );

    expect(enqueueCredentialPipelineMock).toHaveBeenCalledTimes(1);
    const job = enqueueCredentialPipelineMock.mock.calls[0]![1];
    expect((job as unknown as Record<string, unknown>)['flow']).toBe('b2b');
    expect((job as unknown as Record<string, unknown>)['firmId']).toBe(FIRM_B2B_ID);
    expect((job as unknown as Record<string, unknown>)['userRef']).toBe('b2b-userref-1');
    expect(job).toMatchObject({
      kycSessionId: SESS_B2B_ID,
      diditSessionId: 'didit-b2b-1',
      phase: 'identity',
    });
    expect(outcome.kind).toBe('stuck_mint_resolved');
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({ flow: 'b2b' });
  });

  it('singleton dedup hit (enqueue returns null) → skipped + stuck_mint_detected audit', async () => {
    enqueueCredentialPipelineMock.mockResolvedValueOnce(null);
    const stub = freshStub();
    const db = buildDb(stub);
    const outcome = await reconcileStuckMint(
      { db: db as never, boss: {} as never, now: NOW },
      STUCK_CUSTOMER_CANDIDATE,
    );

    expect(outcome.kind).toBe('stuck_mint_skipped');
    if (outcome.kind === 'stuck_mint_skipped') {
      expect(outcome.reason).toBe('enqueue_returned_null');
    }
    // Detected audit (NOT resolved) — count of resolved entries
    // must not inflate when the original job is still in flight.
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0]![1].action).toBe(
      'kyc_reconciler.stuck_mint_detected',
    );
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      reason: 'singleton_dedup_active',
    });
  });

  it('customer candidate missing customerId is fail-safe (stuck_mint_skipped)', async () => {
    const broken: StuckMintCandidate = {
      ...STUCK_CUSTOMER_CANDIDATE,
      customerId: null,
    };
    const stub = freshStub();
    const db = buildDb(stub);
    const outcome = await reconcileStuckMint(
      { db: db as never, boss: {} as never, now: NOW },
      broken,
    );

    expect(outcome.kind).toBe('stuck_mint_skipped');
    if (outcome.kind === 'stuck_mint_skipped') {
      expect(outcome.reason).toBe('invalid_session_kind');
    }
    expect(enqueueCredentialPipelineMock).not.toHaveBeenCalled();
    // Audit detected with reason explaining the mismatch.
    expect(writeAuditMock.mock.calls[0]![1].action).toBe(
      'kyc_reconciler.stuck_mint_detected',
    );
    expect(writeAuditMock.mock.calls[0]![1].meta).toMatchObject({
      reason: 'customer_session_missing_customer_id',
    });
  });

  it('audit target.kind is credential (NOT customer) — pinned for SoC drilldowns', async () => {
    enqueueCredentialPipelineMock.mockResolvedValueOnce('job-x');
    const stub = freshStub();
    const db = buildDb(stub);
    await reconcileStuckMint(
      { db: db as never, boss: {} as never, now: NOW },
      STUCK_CUSTOMER_CANDIDATE,
    );
    expect(writeAuditMock.mock.calls[0]![1].target.kind).toBe('credential');
  });
});
