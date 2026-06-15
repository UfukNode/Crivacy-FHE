/**
 * Shared test fixtures for the audit-log suite.
 *
 * Unlike the rate-limit suite (which goes through raw
 * `tx.execute(sql)`), the audit writer uses Drizzle's query-builder
 * surface:
 *
 *   * `db.insert(auditLog).values(row|rows).returning()` — writer
 *   * `db.select().from(auditLog).where(...).orderBy(...).limit(...)`
 *     — query
 *
 * Both of these are chain APIs that resolve to row arrays. The mock
 * here builds a chain proxy that records each step. The terminal
 * methods (`.returning()` for inserts, `.limit()` for selects) are
 * `async` so awaiting them pulls the next entry off the FIFO row
 * queue. Tests queue rows up-front and assert on the captured chain.
 *
 * The mock is **not** a Postgres replica — it does no plan rewriting,
 * no type coercion, no constraint enforcement. It exists solely so
 * unit tests can exercise `writer.ts` and `query.ts` without docker.
 * End-to-end integration tests (step 30 of PLAN.md) hit a real
 * Postgres instance.
 */

import { vi } from 'vitest';

import type { AuditAction, AuditTargetKind, PersistedAuditRow, WriteAuditInput } from '@/lib/audit';
import { firmUserActor, noTarget, systemActor, uuidTarget } from '@/lib/audit';
import type { CrivacyDatabase } from '@/lib/db/client';

/* ---------- Fixed values ---------- */

export const FIXTURE_FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_FIRM_ID_B = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_USER_ID = '33333333-3333-4333-8333-333333333333';
export const FIXTURE_USER_ID_B = '44444444-4444-4444-8444-444444444444';
export const FIXTURE_API_KEY_ID = '55555555-5555-4555-8555-555555555555';
export const FIXTURE_ADMIN_ID = '66666666-6666-4666-8666-666666666666';
export const FIXTURE_SESSION_ID = '77777777-7777-4777-8777-777777777777';
export const FIXTURE_REQUEST_ID = '88888888-8888-4888-8888-888888888888';

/** 2026-04-10T09:30:00 UTC — stable reference timestamp. */
export const FIXTURE_NOW = new Date('2026-04-10T09:30:00.000Z');

/* ---------- Mock DB types ---------- */

/**
 * Captured query step. Each chain method appends one of these so
 * tests can assert the sequence of calls.
 */
export interface CapturedStep {
  readonly op:
    | 'insert'
    | 'values'
    | 'returning'
    | 'select'
    | 'from'
    | 'where'
    | 'orderBy'
    | 'limit';
  readonly payload?: unknown;
}

/**
 * Queued return value — the rows the next chain resolves to. `tag`
 * is a human-readable label that tests inspect when a failure message
 * points at "the second row queue entry" so they know which is which.
 */
export interface QueuedResult {
  readonly tag: string;
  readonly rows: readonly Record<string, unknown>[];
  /** If set, the chain throws this error instead of resolving rows. */
  readonly error?: Error;
}

/** Handle for controlling the mock between steps. */
export interface MockDbHandle {
  readonly db: CrivacyDatabase;
  readonly steps: CapturedStep[];
  readonly queue: (result: QueuedResult) => void;
  readonly reset: () => void;
}

/* ---------- Mock DB builder ---------- */

/**
 * Build a fresh mock `CrivacyDatabase`. The mock exposes chainable
 * `.insert()` and `.select()` entry points. The terminal `async`
 * methods (`.returning()` for inserts, `.limit()` for selects)
 * dequeue one entry from the FIFO row queue when awaited.
 *
 * The tests queue rows **in the order the SUT will consume them**.
 * A single writer call takes one queue entry (the `.returning()`
 * result). A single query call also takes one (the `.limit()`
 * result).
 */
export function buildMockDb(): MockDbHandle {
  const steps: CapturedStep[] = [];
  const queue: QueuedResult[] = [];

  const takeNext = (operation: string): Promise<readonly Record<string, unknown>[]> => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        `mock db ${operation} called but no queued result — queue is empty. Did you forget to queue a row set?`,
      );
    }
    if (next.error !== undefined) {
      return Promise.reject(next.error);
    }
    return Promise.resolve(next.rows);
  };

  /* ---- INSERT chain ---- */
  // `insert(table) → { values(row|rows) → { returning() → Promise<rows> } }`
  const insert = vi.fn((table: unknown) => {
    steps.push({ op: 'insert', payload: table });
    return {
      values: vi.fn((value: unknown) => {
        steps.push({ op: 'values', payload: value });
        return {
          returning: vi.fn(() => {
            steps.push({ op: 'returning' });
            return takeNext('insert.returning');
          }),
        };
      }),
    };
  });

  /* ---- SELECT chain ---- */
  // `select() → from(table) → where(expr) → orderBy(...) → limit(n) → Promise<rows>`
  // Only `.limit()` is awaitable — it pulls one row set off the queue.
  const select = vi.fn(() => {
    steps.push({ op: 'select' });
    return makeSelectChain(steps, takeNext);
  });

  const db = {
    insert,
    select,
  } as unknown as CrivacyDatabase;

  return {
    db,
    steps,
    queue: (result) => {
      queue.push(result);
    },
    reset: () => {
      steps.length = 0;
      queue.length = 0;
      insert.mockClear();
      select.mockClear();
    },
  };
}

/**
 * Build a select-chain proxy. Each hop records the step and returns
 * a new proxy with the remaining methods. Awaiting resolves via the
 * row queue. Node is kept minimal — tests only call the methods the
 * SUT uses.
 */
function makeSelectChain(
  steps: CapturedStep[],
  takeNext: (operation: string) => Promise<readonly Record<string, unknown>[]>,
): {
  readonly from: (table: unknown) => ThenableSelectChain;
} {
  return {
    from: (table: unknown): ThenableSelectChain => {
      steps.push({ op: 'from', payload: table });
      return makeWhereChain(steps, takeNext);
    },
  };
}

interface ThenableSelectChain {
  readonly where: (expr: unknown) => ThenableSelectChain;
  readonly orderBy: (...exprs: unknown[]) => ThenableSelectChain;
  readonly limit: (n: number) => Promise<readonly Record<string, unknown>[]>;
}

function makeWhereChain(
  steps: CapturedStep[],
  takeNext: (operation: string) => Promise<readonly Record<string, unknown>[]>,
): ThenableSelectChain {
  const chain: ThenableSelectChain = {
    where: (expr: unknown) => {
      steps.push({ op: 'where', payload: expr });
      return chain;
    },
    orderBy: (...exprs: unknown[]) => {
      steps.push({ op: 'orderBy', payload: exprs });
      return chain;
    },
    limit: async (n: number) => {
      steps.push({ op: 'limit', payload: n });
      return takeNext('select.limit');
    },
  };
  return chain;
}

/* ---------- Row builders ---------- */

/**
 * Build a fake `audit_log` row as Drizzle would return it from
 * `$inferSelect` — camelCase keys, `meta` as a plain object, `ts` as
 * a JS `Date`, `id` as a plain number (bigserial mode 'number').
 *
 * Any field not overridden defaults to a reasonable stable fixture.
 * Callers that want a null field should pass `null` explicitly —
 * the builder uses `'key' in overrides` to distinguish "explicit null"
 * from "not supplied" so null values survive.
 */
export function buildAuditRow(
  overrides: Partial<{
    id: number;
    actorKind: 'firm_user' | 'admin_user' | 'api_key' | 'system';
    actorId: string | null;
    actorLabel: string;
    firmId: string | null;
    action: AuditAction;
    targetKind: AuditTargetKind | null;
    targetId: string | null;
    targetRef: string | null;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
    meta: Readonly<Record<string, unknown>>;
    ts: Date;
  }> = {},
): Record<string, unknown> {
  return {
    id: pick(overrides, 'id', 1),
    actorKind: pick(overrides, 'actorKind', 'firm_user'),
    actorId: pick(overrides, 'actorId', FIXTURE_USER_ID),
    actorLabel: pick(overrides, 'actorLabel', 'alice@acme.test'),
    firmId: pick(overrides, 'firmId', FIXTURE_FIRM_ID),
    action: pick(overrides, 'action', 'firm_user.login.success'),
    targetKind: pick(overrides, 'targetKind', 'firm_user'),
    targetId: pick(overrides, 'targetId', FIXTURE_USER_ID),
    targetRef: pick(overrides, 'targetRef', null),
    ip: pick(overrides, 'ip', '10.0.0.1'),
    userAgent: pick(overrides, 'userAgent', 'vitest/1.0'),
    requestId: pick(overrides, 'requestId', FIXTURE_REQUEST_ID),
    meta: pick(overrides, 'meta', {}),
    ts: pick(overrides, 'ts', FIXTURE_NOW),
  };
}

/**
 * Build a fully-formed `PersistedAuditRow` (i.e. the hydrated shape
 * the public writer/query API returns). Used by chain/redact tests
 * that don't go through the mock DB at all. Explicit `null` overrides
 * are preserved; `undefined` / absent keys get a stable default.
 */
export function buildPersistedRow(overrides: Partial<PersistedAuditRow> = {}): PersistedAuditRow {
  return {
    id: pick(overrides, 'id', 1),
    actorKind: pick(overrides, 'actorKind', 'firm_user'),
    actorId: pick(overrides, 'actorId', FIXTURE_USER_ID),
    actorLabel: pick(overrides, 'actorLabel', 'alice@acme.test'),
    firmId: pick(overrides, 'firmId', FIXTURE_FIRM_ID),
    action: pick(overrides, 'action', 'firm_user.login.success'),
    targetKind: pick(overrides, 'targetKind', 'firm_user'),
    targetId: pick(overrides, 'targetId', FIXTURE_USER_ID),
    targetRef: pick(overrides, 'targetRef', null),
    ip: pick(overrides, 'ip', '10.0.0.1'),
    userAgent: pick(overrides, 'userAgent', 'vitest/1.0'),
    requestId: pick(overrides, 'requestId', FIXTURE_REQUEST_ID),
    meta: pick(overrides, 'meta', {}),
    ts: pick(overrides, 'ts', FIXTURE_NOW),
  };
}

/**
 * Null-preserving "pick this field from `overrides` or use default":
 * the undefined check means an explicit `undefined` falls back to the
 * default, while an explicit `null` passes through as a valid value
 * (row types like `actorId: string | null` accept null).
 *
 * The generic is parameterized on the underlying row type `T` with
 * `overrides: Partial<T>`, so callers get `T[K]` back (without the
 * `| undefined` that `Partial<T>[K]` would otherwise carry).
 */
function pick<T, K extends keyof T>(overrides: Partial<T>, key: K, fallback: T[K]): T[K] {
  const value = overrides[key];
  if (value !== undefined) {
    return value as T[K];
  }
  return fallback;
}

/* ---------- Ready-made write inputs ---------- */

/**
 * A canonical valid single-row write input, used as a "happy path"
 * seed across the writer tests. Tests override fields with the
 * spread operator as needed.
 */
export function buildWriteInput(overrides: Partial<WriteAuditInput> = {}): WriteAuditInput {
  const base: WriteAuditInput = {
    action: 'firm_user.login.success',
    actor: firmUserActor({
      id: FIXTURE_USER_ID,
      label: 'alice@acme.test',
      firmId: FIXTURE_FIRM_ID,
    }),
    target: uuidTarget({
      kind: 'firm_user',
      id: FIXTURE_USER_ID,
    }),
    context: {
      ip: '10.0.0.1',
      userAgent: 'vitest/1.0',
      requestId: FIXTURE_REQUEST_ID,
    },
    meta: { source: 'unit-test' },
    ts: FIXTURE_NOW,
  };
  return { ...base, ...overrides };
}

/** Write input for a system-triggered event. Uses `noTarget()`. */
export function buildSystemWriteInput(overrides: Partial<WriteAuditInput> = {}): WriteAuditInput {
  const base: WriteAuditInput = {
    action: 'system.backup.started',
    actor: systemActor('backup-worker'),
    target: noTarget(),
    meta: { schedule: 'nightly' },
    ts: FIXTURE_NOW,
  };
  return { ...base, ...overrides };
}
