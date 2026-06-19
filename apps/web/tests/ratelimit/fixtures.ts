/**
 * Shared test fixtures for the rate-limit suite.
 *
 * The library has two test surfaces:
 *
 *   1. Pure-math modules (`bucket`, `periods`, `headers`, `tiers`,
 *      `errors`) run without any DB mock — they're deterministic
 *      functions of their inputs.
 *
 *   2. SQL-facing modules (`token-bucket`, `quota`, `middleware`)
 *      need a fake `CrivacyDatabase` that answers `.transaction()`
 *      and `.execute()`. This file provides a tiny in-memory fake
 *      that records every SQL call and returns rows from a queue.
 *
 * The fake intentionally does NOT try to be a Postgres replica. It
 * returns rows you queue in order, and lets assertions inspect the
 * SQL-chunk sequence to verify the library issued the expected
 * statements in the expected order. This keeps the test cost near
 * zero (no docker, no migrations) while still covering both the
 * happy path and the malformed-row / missing-row branches.
 */

import { vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import { type TierLimits, resolveTierLimits } from '@/lib/ratelimit';

/* ---------- Fixed values ---------- */

/** Stable UUID used as the firm PK (bucket + quota) across tests. */
export const FIXTURE_FIRM_ID = '11111111-1111-4111-8111-111111111111';

/** Second firm UUID, used for isolation tests. */
export const FIXTURE_FIRM_ID_B = '22222222-2222-4222-8222-222222222222';

/** 2026-03-15 12:00:00 UTC — mid-March fixture time. */
export const FIXTURE_NOW = new Date('2026-03-15T12:00:00.000Z');

/** Free tier limits for convenience. */
export const FIXTURE_FREE_LIMITS: TierLimits = resolveTierLimits('free');

/** Pro tier limits for convenience. */
export const FIXTURE_PRO_LIMITS: TierLimits = resolveTierLimits('pro');

/** Enterprise (unlimited) tier limits for convenience. */
export const FIXTURE_ENTERPRISE_LIMITS: TierLimits = resolveTierLimits('enterprise');

/* ---------- Mock DB ---------- */

/**
 * Captured call record. The library goes through `tx.execute(sql)`
 * where `sql` is a drizzle `SQL` object; `sqlString` serializes the
 * query chunks to a whitespace-normalized string so tests can do
 * substring checks (`expect(sqlString).toContain('INSERT INTO
 * rate_limit_buckets')`).
 */
export interface CapturedCall {
  readonly sqlString: string;
}

/**
 * A queued fake row set. `rows` is what the next `execute` call
 * returns; `tag` is a debug label the test can inspect on failure.
 */
export interface QueuedResult {
  readonly tag: string;
  readonly rows: unknown[];
}

/**
 * Control handle returned by `buildMockDb`. The test harness uses
 * `queue` to prime the row returns, and reads `calls` after running
 * the subject under test to assert the SQL flow.
 */
export interface MockDbHandle {
  readonly db: CrivacyDatabase;
  readonly calls: CapturedCall[];
  readonly queue: (result: QueuedResult) => void;
  readonly reset: () => void;
  /** True if `.transaction()` was opened at least once. */
  readonly transactionOpened: () => boolean;
}

/**
 * Convert a drizzle `SQL`-like object to a normalized string. Drizzle
 * exposes `queryChunks` as an array of `StringChunk` / `Param`
 * instances; we serialize each by `toString`. The result is a rough
 * signature, not a Postgres wire-protocol query — good enough for
 * substring assertions, which is all the tests need.
 */
function normalizeSql(sql: unknown): string {
  if (sql === null || sql === undefined) {
    return '';
  }
  if (typeof sql === 'string') {
    return sql.replace(/\s+/g, ' ').trim();
  }
  if (typeof sql !== 'object') {
    return String(sql).replace(/\s+/g, ' ').trim();
  }
  const candidate = sql as { readonly queryChunks?: unknown[] };
  if (Array.isArray(candidate.queryChunks)) {
    const joined = candidate.queryChunks
      .map((chunk) => {
        if (chunk === null || chunk === undefined) {
          return '';
        }
        if (typeof chunk === 'string') {
          return chunk;
        }
        // Primitives other than strings (numbers, bigints, booleans,
        // Dates etc.) are interpolated `Param` values — they don't
        // contribute to the query signature.
        if (typeof chunk !== 'object') {
          return '';
        }
        const inner = chunk as { readonly value?: unknown };
        if ('value' in inner) {
          if (typeof inner.value === 'string') {
            return inner.value;
          }
          if (Array.isArray(inner.value)) {
            // Drizzle's `StringChunk` stores the literal SQL text between
            // interpolations as `string[]`. Join it so the substring
            // assertions in the tests see the full query signature.
            return inner.value
              .map((segment) => (typeof segment === 'string' ? segment : ''))
              .join('');
          }
        }
        return '';
      })
      .join(' ');
    return joined.replace(/\s+/g, ' ').trim();
  }
  return String(sql).replace(/\s+/g, ' ').trim();
}

/**
 * Build a fresh mock `CrivacyDatabase` instance. Each test usually
 * builds its own so the queue and call log don't leak between cases.
 */
export function buildMockDb(): MockDbHandle {
  const calls: CapturedCall[] = [];
  const queue: QueuedResult[] = [];
  let txOpened = false;

  const execute = vi.fn(async (sqlArg: unknown) => {
    const sqlString = normalizeSql(sqlArg);
    calls.push({ sqlString });
    const next = queue.shift();
    if (next === undefined) {
      return { rows: [] };
    }
    return { rows: next.rows };
  });

  const tx = { execute };

  const transaction = vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => {
    txOpened = true;
    return cb(tx);
  });

  const db = {
    execute,
    transaction,
  } as unknown as CrivacyDatabase;

  return {
    db,
    calls,
    queue: (result) => {
      queue.push(result);
    },
    reset: () => {
      calls.length = 0;
      queue.length = 0;
      txOpened = false;
      execute.mockClear();
      transaction.mockClear();
    },
    transactionOpened: () => txOpened,
  };
}

/* ---------- Row builders ---------- */

/**
 * Build a fake `rate_limit_buckets` row as node-postgres would
 * serialize it: `numeric` as strings, `integer` as a number,
 * `timestamp` as a `Date`.
 */
export function buildBucketRow(overrides: {
  readonly capacity?: number;
  readonly refillRatePerSec?: number | string;
  readonly tokens?: number | string;
  readonly lastRefillAt?: Date;
}): Record<string, unknown> {
  return {
    capacity: overrides.capacity ?? 5,
    refill_rate_per_sec:
      typeof overrides.refillRatePerSec === 'number'
        ? overrides.refillRatePerSec.toFixed(4)
        : (overrides.refillRatePerSec ?? '1.0000'),
    tokens:
      typeof overrides.tokens === 'number'
        ? overrides.tokens.toFixed(6)
        : (overrides.tokens ?? '5.000000'),
    last_refill_at: overrides.lastRefillAt ?? FIXTURE_NOW,
  };
}

/**
 * Build a fake `quota_counters` row. `count`, `limit_snapshot` and
 * `overage_count` are `bigint` columns, which Drizzle returns as
 * `number` (mode `'number'`) — so plain numbers here are correct.
 */
export function buildQuotaRow(overrides: {
  readonly count?: number;
  readonly limitSnapshot?: number;
  readonly overageCount?: number;
  readonly resetAt?: Date;
}): Record<string, unknown> {
  return {
    count: overrides.count ?? 1,
    limit_snapshot: overrides.limitSnapshot ?? 1_000,
    overage_count: overrides.overageCount ?? 0,
    reset_at: overrides.resetAt ?? new Date('2026-04-01T00:00:00.000Z'),
  };
}
