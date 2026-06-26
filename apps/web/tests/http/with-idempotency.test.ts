// @vitest-environment node
/**
 * withIdempotency HOF — unit coverage after claim-first refactor.
 *
 * Scenarios covered:
 *   - No header → handler runs, zero DB calls.
 *   - Claim wins → handler runs, store persists.
 *   - Claim loses + cached hit → handler does NOT run, cached response.
 *   - Claim loses + cached mismatch → 409 mismatch, handler does NOT run.
 *   - Claim loses + pending past timeout → 409 in_progress.
 *   - Handler throws → release claim (DELETE pending row), error propagates.
 *   - 5xx response → not cached (storeIdempotencyKey filters).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';

import { withIdempotency } from '@/lib/http/with-idempotency';

/* -------------------------------------------------------------------------- */
/*  Mock DB                                                                    */
/* -------------------------------------------------------------------------- */

interface MockDb {
  readonly db: CrivacyDatabase;
  readonly executes: { sqlString: string }[];
  readonly queueRows: (rows: unknown[]) => void;
  readonly reset: () => void;
}

function normalizeSqlDeep(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return String(arg);
  const c = arg as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(c.queryChunks)) {
    return c.queryChunks.map((x) => normalizeSqlDeep(x)).join(' ');
  }
  if ('value' in c) {
    if (typeof c.value === 'string') return c.value;
    if (Array.isArray(c.value)) {
      return c.value.map((s) => (typeof s === 'string' ? s : '')).join('');
    }
    return '?';
  }
  return '';
}

function buildMockDb(): MockDb {
  const executes: { sqlString: string }[] = [];
  const rowQueue: unknown[][] = [];

  const execute = vi.fn(async (sqlArg: unknown) => {
    const sqlString = normalizeSqlDeep(sqlArg).replace(/\s+/g, ' ').trim();
    executes.push({ sqlString });
    return { rows: rowQueue.shift() ?? [] };
  });

  return {
    db: { execute } as unknown as CrivacyDatabase,
    executes,
    queueRows: (rows) => {
      rowQueue.push(rows);
    },
    reset: () => {
      executes.length = 0;
      rowQueue.length = 0;
      execute.mockClear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-04-22T12:00:00.000Z');
const SUBJECT = { kind: 'customer' as const, id: 'cust-1' };
const ENDPOINT = 'customer.profile.change-password';

function buildCtx(mock: MockDb, headerValue: string | null) {
  const headers: Record<string, string> = {};
  if (headerValue !== null) headers['idempotency-key'] = headerValue;
  return {
    db: mock.db,
    request: new NextRequest('https://example.com/x', { headers }),
    requestId: 'req-abc',
    now: NOW,
  };
}

function sha256(value: string): string {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical JSON produced by the HOF's internal `stableStringify`.
 * Sorted keys at every depth, so `{a, b}` and `{b, a}` both produce
 * `{"a":1,"b":2}`. The primitive's request_hash is sha256 of this.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('http/with-idempotency — claim-first', () => {
  let mock: MockDb;

  beforeEach(() => {
    mock = buildMockDb();
  });

  it('runs handler without any DB calls when the header is absent', async () => {
    const handler = vi.fn(async () =>
      NextResponse.json({ ok: true }, { status: 200 }),
    );

    const res = await withIdempotency(
      { ctx: buildCtx(mock, null), endpoint: ENDPOINT, subject: SUBJECT, body: { a: 1 } },
      handler,
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mock.executes).toHaveLength(0);
  });

  it('claim wins → runs handler and stores the response', async () => {
    // Claim INSERT returns a fresh pending row.
    mock.queueRows([
      { id: 'claim-row' },
    ]);
    // Store's guarded UPDATE finds our pending claim → returns row.
    // No fallback INSERT fires.
    mock.queueRows([{ id: 'claim-row' }]);

    const handler = vi.fn(async () =>
      NextResponse.json({ changed: true }, { status: 200 }),
    );

    const res = await withIdempotency(
      {
        ctx: buildCtx(mock, 'idem-first-seen-123'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body: { a: 1 },
      },
      handler,
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    // Claim INSERT + store UPDATE = 2 executes.
    expect(mock.executes).toHaveLength(2);
    expect(mock.executes[0]?.sqlString).toContain('INSERT INTO');
    expect(mock.executes[0]?.sqlString).toContain('ON CONFLICT');
    expect(mock.executes[1]?.sqlString).toContain('UPDATE');
    expect(mock.executes[1]?.sqlString).toContain('request_hash');
  });

  it('claim loses + cached hit → returns cached response, handler not run', async () => {
    // Claim INSERT returns empty (conflict, not expired → no update).
    mock.queueRows([]);
    const body = { a: 1 };
    // SELECT returns the cached terminal row.
    mock.queueRows([
      {
        request_hash: sha256(stableStringify(body)),
        response_status: 200,
        response_body: JSON.stringify({ changed: true }),
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      },
    ]);

    const handler = vi.fn(async () => NextResponse.json({ should: 'not run' }));

    const res = await withIdempotency(
      {
        ctx: buildCtx(mock, 'idem-replay-123'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body,
      },
      handler,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ changed: true }));
    expect(res.headers.get('idempotency-replay')).toBe('true');
    expect(handler).not.toHaveBeenCalled();
  });

  it('claim loses + body hash mismatch → 409 mismatch, handler not run', async () => {
    mock.queueRows([]); // claim lost
    mock.queueRows([
      {
        request_hash: sha256(stableStringify({ a: 'different' })),
        response_status: 200,
        response_body: JSON.stringify({ changed: true }),
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      },
    ]);

    const handler = vi.fn(async () => NextResponse.json({ should: 'not run' }));

    const res = await withIdempotency(
      {
        ctx: buildCtx(mock, 'idem-mismatch-123'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body: { a: 1 },
      },
      handler,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_mismatch');
    expect(handler).not.toHaveBeenCalled();
  });

  it('claim loses + pending past poll timeout → 409 in_progress, handler not run', async () => {
    mock.queueRows([]); // claim lost
    // Every SELECT returns the pending row — claim poll timeout.
    const pending = {
      request_hash: sha256(stableStringify({ a: 1 })),
      response_status: 0,
      response_body: '',
      expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
    };
    for (let i = 0; i < 50; i++) mock.queueRows([pending]);

    const handler = vi.fn(async () => NextResponse.json({ should: 'not run' }));

    const res = await withIdempotency(
      {
        ctx: buildCtx(mock, 'idem-in-progress-123'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body: { a: 1 },
      },
      handler,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_in_progress');
    expect(handler).not.toHaveBeenCalled();
  }, 10_000);

  it('handler throws → releases the claim (DELETE pending) and propagates the error', async () => {
    // Claim wins.
    mock.queueRows([
      {
        request_hash: sha256(stableStringify({ a: 1 })),
        response_status: 0,
        response_body: '',
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
        was_insert: true,
      },
    ]);
    // releaseClaim's DELETE returns nothing.
    mock.queueRows([]);

    const handler = vi.fn(async () => {
      throw new Error('handler crashed');
    });

    await expect(
      withIdempotency(
        {
          ctx: buildCtx(mock, 'idem-throw-123'),
          endpoint: ENDPOINT,
          subject: SUBJECT,
          body: { a: 1 },
        },
        handler,
      ),
    ).rejects.toThrow('handler crashed');

    // Two executes: the claim INSERT + the release DELETE.
    expect(mock.executes).toHaveLength(2);
    expect(mock.executes[0]?.sqlString).toContain('INSERT INTO');
    expect(mock.executes[1]?.sqlString).toContain('DELETE');
    // Release only removes pending rows so a completed row from
    // another caller is not nuked by mistake.
    expect(mock.executes[1]?.sqlString).toContain('response_status = 0');
  });

  it('5xx response does not get cached even on claim success', async () => {
    mock.queueRows([
      {
        request_hash: sha256(stableStringify({ a: 1 })),
        response_status: 0,
        response_body: '',
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
        was_insert: true,
      },
    ]);
    // storeIdempotencyKey filters non-cacheable → no execute for
    // the 5xx case. Don't queue anything else.

    const handler = vi.fn(async () =>
      NextResponse.json({ error: 'boom' }, { status: 500 }),
    );

    const res = await withIdempotency(
      {
        ctx: buildCtx(mock, 'idem-fivehundred-123'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body: { a: 1 },
      },
      handler,
    );

    expect(res.status).toBe(500);
    // Only the claim INSERT ran; store was called but filtered out.
    expect(mock.executes).toHaveLength(1);
    expect(mock.executes[0]?.sqlString).toContain('INSERT INTO');
  });

  it('below-minimum keys short-circuit to the no-header path', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));

    await withIdempotency(
      {
        ctx: buildCtx(mock, 'short'),
        endpoint: ENDPOINT,
        subject: SUBJECT,
        body: { a: 1 },
      },
      handler,
    );

    expect(mock.executes).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
