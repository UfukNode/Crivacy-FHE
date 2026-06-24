// @vitest-environment node
/**
 * Idempotency primitive — unit coverage.
 *
 * Post claim-first refactor the lookup call atomically INSERTs a
 * pending row; the mock DB here feeds the synthetic result of that
 * INSERT (the row itself on claim-success, empty on conflict) plus
 * any follow-up SELECT the primitive issues on the claim-loss path.
 *
 * Scenarios covered:
 *   - Header parsing: null for missing / short / long / whitespace
 *   - Claim wins → first_seen
 *   - Claim loses + cached terminal → hit
 *   - Claim loses + cached terminal with different body → mismatch
 *   - Claim loses + pending row → in_progress after poll timeout
 *   - Store writes INSERT ON CONFLICT DO UPDATE for cacheable statuses
 *   - Store drops 5xx
 *   - Mismatch response envelope + in_progress response envelope
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';

import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  extractIdempotencyKey,
  idempotencyInProgressResponse,
  idempotencyMismatchResponse,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  type IdempotencySubject,
} from '@/lib/http/idempotency';

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

  const db = { execute } as unknown as CrivacyDatabase;

  return {
    db,
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

const SUBJECT: IdempotencySubject = {
  kind: 'customer',
  id: '11111111-1111-4111-8111-111111111111',
};
const ENDPOINT = '/api/customer/profile/change-password';
const KEY = 'idem-abcdef123456';
const REQUEST_BODY = JSON.stringify({ a: 1 });
const NOW = new Date('2026-04-22T12:00:00.000Z');

function sha256(value: string): string {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('http/idempotency', () => {
  /* ---------------------- extractIdempotencyKey --------------------- */

  describe('extractIdempotencyKey', () => {
    function build(headerValue: string | undefined): Request {
      const headers: Record<string, string> = {};
      if (headerValue !== undefined) headers['idempotency-key'] = headerValue;
      return new Request('https://example.com/x', { headers });
    }

    it('returns null when the header is absent', () => {
      expect(extractIdempotencyKey(build(undefined))).toBeNull();
    });

    it('returns null for a whitespace-only key', () => {
      expect(extractIdempotencyKey(build('   '))).toBeNull();
    });

    it('returns null for a key below the minimum length', () => {
      expect(extractIdempotencyKey(build('short'))).toBeNull();
    });

    it('returns null for a key above the maximum length', () => {
      const tooLong = 'x'.repeat(300);
      expect(extractIdempotencyKey(build(tooLong))).toBeNull();
    });

    it('returns the trimmed key when valid', () => {
      expect(extractIdempotencyKey(build('  idem-key-123456  '))).toBe('idem-key-123456');
    });
  });

  /* -------------------------- lookupIdempotencyKey -------------------------- */

  describe('lookupIdempotencyKey — claim-first pattern', () => {
    let mock: MockDb;

    beforeEach(() => {
      mock = buildMockDb();
    });

    it('returns first_seen when the claim INSERT wins the conflict race', async () => {
      // The claim returns a row — meaning the atomic INSERT (with
      // ON CONFLICT DO UPDATE WHERE expired) landed a fresh pending
      // row for us. That is the race winner.
      mock.queueRows([
        {
          request_hash: sha256(REQUEST_BODY),
          response_status: 0,
          response_body: '',
          expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
          was_insert: true,
        },
      ]);

      const got = await lookupIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        now: NOW,
      });

      expect(got).toEqual({ status: 'first_seen' });

      // Only the claim INSERT ran — no follow-up SELECT needed.
      expect(mock.executes).toHaveLength(1);
      const sqlString = mock.executes[0]?.sqlString ?? '';
      expect(sqlString).toContain('INSERT INTO');
      expect(sqlString).toContain('idempotency_keys');
      expect(sqlString).toContain('ON CONFLICT');
      expect(sqlString).toContain('DO UPDATE');
      // Stale-reclaim guard — only overwrite if existing expired.
      expect(sqlString).toContain('expires_at');
    });

    it('returns hit when claim loses and existing row has a cached terminal response', async () => {
      // Claim INSERT returns no row (ON CONFLICT DO UPDATE's WHERE
      // blocked the update — existing row is not expired).
      mock.queueRows([]);
      // SELECT returns the existing cached row.
      const cachedBody = JSON.stringify({ changed: true });
      mock.queueRows([
        {
          request_hash: sha256(REQUEST_BODY),
          response_status: 200,
          response_body: cachedBody,
          expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        },
      ]);

      const got = await lookupIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        now: NOW,
      });

      expect(got.status).toBe('hit');
      if (got.status === 'hit') {
        expect(got.response.status).toBe(200);
        expect(got.response.headers.get('idempotency-replay')).toBe('true');
        expect(await got.response.text()).toBe(cachedBody);
      }
      expect(mock.executes).toHaveLength(2);
      expect(mock.executes[0]?.sqlString).toContain('INSERT INTO');
      expect(mock.executes[1]?.sqlString).toContain('SELECT');
    });

    it('returns mismatch when claim loses and cached row has a different body hash', async () => {
      mock.queueRows([]); // claim lost
      mock.queueRows([
        {
          request_hash: sha256('{"different":"body"}'),
          response_status: 200,
          response_body: JSON.stringify({ changed: true }),
          expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        },
      ]);

      const got = await lookupIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        now: NOW,
      });

      expect(got).toEqual({ status: 'mismatch' });
    });

    it('returns in_progress when claim loses and existing row is pending past the poll timeout', async () => {
      mock.queueRows([]); // claim lost
      // Every SELECT returns the pending row — the poll loop will
      // give up after CLAIM_POLL_TIMEOUT_MS and return in_progress.
      const pendingRow = {
        request_hash: sha256(REQUEST_BODY),
        response_status: 0,
        response_body: '',
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
      };
      // Initial SELECT + several poll SELECTs — queue enough copies
      // so no execute returns an empty batch.
      for (let i = 0; i < 50; i++) mock.queueRows([pendingRow]);

      const got = await lookupIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        now: NOW,
      });

      expect(got).toEqual({ status: 'in_progress' });
    }, 10_000);

    it('returns hit when a pending claim completes mid-poll', async () => {
      mock.queueRows([]); // claim lost
      const pendingRow = {
        request_hash: sha256(REQUEST_BODY),
        response_status: 0,
        response_body: '',
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
      };
      const completedRow = {
        request_hash: sha256(REQUEST_BODY),
        response_status: 200,
        response_body: JSON.stringify({ changed: true }),
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      };
      // Initial SELECT returns pending; next SELECT returns completed.
      mock.queueRows([pendingRow]);
      mock.queueRows([completedRow]);

      const got = await lookupIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        now: NOW,
      });

      expect(got.status).toBe('hit');
      if (got.status === 'hit') {
        expect(got.response.status).toBe(200);
      }
    }, 10_000);
  });

  /* -------------------------- storeIdempotencyKey --------------------------- */

  describe('storeIdempotencyKey', () => {
    let mock: MockDb;

    beforeEach(() => {
      mock = buildMockDb();
    });

    it('commits via guarded UPDATE when the pending claim row still belongs to us', async () => {
      // UPDATE returns our row → store finishes without running the
      // fallback INSERT. This is the normal commit path.
      mock.queueRows([{ id: 'claim-row-id' }]);

      await storeIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        responseStatus: 200,
        responseBody: JSON.stringify({ changed: true }),
        now: NOW,
      });

      expect(mock.executes).toHaveLength(1);
      const sqlString = mock.executes[0]?.sqlString ?? '';
      expect(sqlString).toContain('UPDATE');
      expect(sqlString).toContain('idempotency_keys');
      // The guard is the whole point: without it a stale caller
      // could overwrite a concurrent winner's cached answer.
      expect(sqlString).toContain('request_hash');
      // Guard on the pending row's response_status = 0 sentinel.
      expect(sqlString).toContain('response_status = 0');
    });

    it('falls back to INSERT ON CONFLICT DO NOTHING when the claim row was swept', async () => {
      // UPDATE returns zero rows — our claim was swept between
      // lookup and store. Store runs the fallback INSERT.
      mock.queueRows([]);
      mock.queueRows([]);

      await storeIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        responseStatus: 200,
        responseBody: JSON.stringify({ changed: true }),
        now: NOW,
      });

      expect(mock.executes).toHaveLength(2);
      expect(mock.executes[0]?.sqlString).toContain('UPDATE');
      expect(mock.executes[1]?.sqlString).toContain('INSERT INTO');
      expect(mock.executes[1]?.sqlString).toContain('ON CONFLICT');
      // Crucially — the fallback uses DO NOTHING, not DO UPDATE.
      // A thief's committed row must NOT be overwritten by our
      // stale response.
      expect(mock.executes[1]?.sqlString).toContain('DO NOTHING');
    });

    it('persists cacheable 4xx responses (409, 410, 422)', async () => {
      for (const status of [400, 404, 409, 410, 422]) {
        const m = buildMockDb();
        m.queueRows([{ id: 'row' }]); // UPDATE succeeds
        await storeIdempotencyKey({
          db: m.db,
          endpoint: ENDPOINT,
          subject: SUBJECT,
          key: KEY,
          requestBody: REQUEST_BODY,
          responseStatus: status,
          responseBody: '{}',
          now: NOW,
        });
        expect(m.executes).toHaveLength(1);
      }
    });

    it('drops 5xx responses so retries after a transient error can actually complete', async () => {
      for (const status of [500, 502, 503, 504]) {
        const m = buildMockDb();
        await storeIdempotencyKey({
          db: m.db,
          endpoint: ENDPOINT,
          subject: SUBJECT,
          key: KEY,
          requestBody: REQUEST_BODY,
          responseStatus: status,
          responseBody: '{"error":"..."}',
          now: NOW,
        });
        expect(m.executes).toHaveLength(0);
      }
    });

    it('uses the default 24h TTL when ttlSeconds is omitted', async () => {
      expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);

      mock.queueRows([{ id: 'row' }]); // UPDATE succeeds
      await storeIdempotencyKey({
        db: mock.db,
        endpoint: ENDPOINT,
        subject: SUBJECT,
        key: KEY,
        requestBody: REQUEST_BODY,
        responseStatus: 200,
        responseBody: '{}',
        now: NOW,
      });
      expect(mock.executes).toHaveLength(1);
    });
  });

  /* -------------------------- response helpers ------------------------------ */

  describe('idempotencyMismatchResponse', () => {
    it('returns a canonical 409 envelope', async () => {
      const res = idempotencyMismatchResponse('req-123');
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; message: string };
        requestId?: string;
      };
      expect(body.error.code).toBe('idempotency_mismatch');
      expect(body.error.message).toMatch(/different request body/);
      expect(body.requestId).toBe('req-123');
    });
  });

  describe('idempotencyInProgressResponse', () => {
    it('returns a 409 envelope with retry-after and in_progress code', async () => {
      const res = idempotencyInProgressResponse('req-456');
      expect(res.status).toBe(409);
      expect(res.headers.get('retry-after')).toBe('1');
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('idempotency_in_progress');
      expect(body.error.message).toMatch(/still processing/);
    });
  });
});
