/**
 * Unit tests for `lib/kyc/mint-progress.ts`. Pins the projector
 * behaviour every callback consumer relies on:
 *
 *   * `null` outside the mint window (non-positive session status,
 *      or the kyc_credentials_meta row already exists);
 *   * `pending` for a freshly enqueued / first-attempt job;
 *   * `retrying` once `retry_count > 0`;
 *   * `failed` when pg-boss exhausted the retry budget;
 *   * graceful no-window when pg-boss reports `completed` without
 *     a meta row yet (vanishing race window — UI must not flash
 *     a stale "still issuing" row in that millisecond).
 *
 * The DB is stubbed by hand (no Drizzle test harness) — the helper
 * only touches a single Drizzle SELECT chain and one raw `db.execute`.
 * That keeps the tests deterministic without spinning Postgres.
 */

import { describe, expect, it } from 'vitest';

import { resolveMintProgress } from '@/lib/kyc/mint-progress';

interface JobRow {
  state: string;
  retry_count: number;
  retry_limit: number;
}

interface StubOptions {
  readonly metaRows?: readonly { id: string }[];
  readonly jobRow?: JobRow | null;
}

/**
 * Build a hand-rolled stub of `CrivacyDatabase` covering the two
 * call paths the helper takes: `db.select(...).from(...).where(...).limit(...)`
 * for the meta lookup, and `db.execute(...)` for the pg-boss raw
 * SQL. Returning a thenable keeps the chained-await semantics drizzle
 * uses without requiring a real query builder.
 */
function buildStubDb(opts: StubOptions): Parameters<typeof resolveMintProgress>[0] {
  const metaRows = opts.metaRows ?? [];
  const jobRow = opts.jobRow ?? null;

  const stub = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => metaRows,
        }),
      }),
    }),
    execute: async () => ({
      rows: jobRow !== null ? [jobRow] : [],
      rowCount: jobRow !== null ? 1 : 0,
    }),
  };
  return stub as unknown as Parameters<typeof resolveMintProgress>[0];
}

const SID = 'a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d';

describe('resolveMintProgress — gate', () => {
  it('returns null when identity session is not yet identity_approved', async () => {
    const result = await resolveMintProgress(buildStubDb({}), {
      kycSessionId: SID,
      sessionStatus: 'in_progress',
      phase: 'identity',
    });
    expect(result).toBeNull();
  });

  it('returns null when address session is not yet approved', async () => {
    const result = await resolveMintProgress(buildStubDb({}), {
      kycSessionId: SID,
      sessionStatus: 'in_review',
      phase: 'address',
    });
    expect(result).toBeNull();
  });

  it('returns null when address session has identity_approved status (wrong phase)', async () => {
    // identity_approved is the identity phase's terminal-positive
    // state, not the address phase's. The address phase wants
    // `approved` to open its mint window.
    const result = await resolveMintProgress(buildStubDb({}), {
      kycSessionId: SID,
      sessionStatus: 'identity_approved',
      phase: 'address',
    });
    expect(result).toBeNull();
  });
});

describe('resolveMintProgress — meta-row short-circuit', () => {
  it('returns null when a kyc_credentials_meta row exists for the session', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ metaRows: [{ id: 'meta-1' }] }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toBeNull();
  });
});

describe('resolveMintProgress — pg-boss state mapping', () => {
  it('returns pending when there is no pg-boss job row yet (just enqueued)', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: null }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toEqual({ state: 'pending', attempts: 1, totalAttempts: 6 });
  });

  it('returns pending for a created job with no retries observed', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'created', retry_count: 0, retry_limit: 5 } }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toEqual({ state: 'pending', attempts: 1, totalAttempts: 6 });
  });

  it('returns pending for an active job (worker fetched but no retries)', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'active', retry_count: 0, retry_limit: 5 } }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result?.state).toBe('pending');
  });

  it('returns retrying once retry_count > 0', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'retry', retry_count: 2, retry_limit: 5 } }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toEqual({ state: 'retrying', attempts: 3, totalAttempts: 6 });
  });

  it('returns failed when pg-boss retired the job', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'failed', retry_count: 5, retry_limit: 5 } }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toEqual({ state: 'failed', attempts: 6, totalAttempts: 6 });
  });

  it('returns null when pg-boss says completed but no meta row yet (vanishing race)', async () => {
    // Worker just landed the on-chain commit + DB INSERT but the
    // status endpoint's snapshot hasn't seen the meta row yet. UI
    // must not flash a stale "still issuing" row in that
    // millisecond — so we collapse to no-window.
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'completed', retry_count: 0, retry_limit: 5 } }),
      { kycSessionId: SID, sessionStatus: 'identity_approved', phase: 'identity' },
    );
    expect(result).toBeNull();
  });
});

describe('resolveMintProgress — totalAttempts mirrors retry_limit', () => {
  it('matches the retry_limit budget (10 → 11 totalAttempts)', async () => {
    const result = await resolveMintProgress(
      buildStubDb({ jobRow: { state: 'retry', retry_count: 4, retry_limit: 10 } }),
      { kycSessionId: SID, sessionStatus: 'approved', phase: 'address' },
    );
    expect(result).toEqual({ state: 'retrying', attempts: 5, totalAttempts: 11 });
  });
});
