// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 15a integration test for the usage
 * tables (`usage_events` and `usage_aggregates`).
 *
 * Both tables carry a direct firm_id FK. Standard pattern.
 * Plan §5 mentioned `monthly_usage_counters` which does not
 * exist — the codebase aggregates monthly history on the fly
 * via `getMonthlyUsageHistory` over usage_aggregates rows.
 *
 * Pre-auth contract pin specific to usage: the hourly rollup
 * worker (PLAN.md step 11) reads usage_events and writes
 * usage_aggregates cross-firm in one pass. When it lands, it
 * MUST run on the admin pool (BYPASSRLS). The test writes a
 * synthetic aggregate row through the admin pool to pin that
 * contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const ADMIN_URL =
  process.env['DATABASE_URL_ADMIN'] !== undefined &&
  process.env['DATABASE_URL_ADMIN'].length > 0
    ? process.env['DATABASE_URL_ADMIN']
    : process.env['DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL_APP'];

const RUN_RLS_TESTS =
  ADMIN_URL !== undefined && ADMIN_URL.length > 0 && APP_URL !== undefined && APP_URL.length > 0;

describe.skipIf(!RUN_RLS_TESTS)('RLS — usage tables (Cat 34b Faz 15a)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-usg-a`;
  const slugB = `${suffix}-usg-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let apiKeyAId: string;
  let apiKeyBId: string;
  let eventAId: number;
  let eventBId: number;
  // usage_aggregates has no surrogate key — composite PK
  // (firm_id, endpoint, hour). Stage hours per fixture firm.
  const fixtureHourA = new Date('2026-04-25T10:00:00Z');
  const fixtureHourB = new Date('2026-04-25T10:00:00Z');

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Usage Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Usage Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    // usage_events.api_key_id is NOT NULL with ON DELETE CASCADE.
    // varchar(12) on prefix — keep nonce short.
    const prefixNonce = Math.random().toString(36).slice(2, 6);
    const kA = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, '$2b$04$x', 'usg-a', 'live') RETURNING id`,
      [firmAId, `crv_${prefixNonce}_a`],
    );
    const kB = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, '$2b$04$x', 'usg-b', 'live') RETURNING id`,
      [firmBId, `crv_${prefixNonce}_b`],
    );
    apiKeyAId = kA.rows[0]!.id;
    apiKeyBId = kB.rows[0]!.id;

    // usage_events fixtures.
    const eA = await admin.query<{ id: number }>(
      `INSERT INTO usage_events
         (firm_id, api_key_id, endpoint, method, status_code, latency_ms, request_id)
       VALUES ($1, $2, '/api/v1/sessions', 'POST', 200, 50, gen_random_uuid())
       RETURNING id`,
      [firmAId, apiKeyAId],
    );
    const eB = await admin.query<{ id: number }>(
      `INSERT INTO usage_events
         (firm_id, api_key_id, endpoint, method, status_code, latency_ms, request_id)
       VALUES ($1, $2, '/api/v1/sessions', 'POST', 200, 50, gen_random_uuid())
       RETURNING id`,
      [firmBId, apiKeyBId],
    );
    eventAId = eA.rows[0]!.id;
    eventBId = eB.rows[0]!.id;

    // usage_aggregates fixtures (composite PK).
    await admin.query(
      `INSERT INTO usage_aggregates
         (firm_id, endpoint, hour, count, billable_count, p50_ms, p95_ms, p99_ms,
          avg_ms, max_ms)
       VALUES ($1, '/api/v1/sessions', $2, 100, 100, 50, 80, 100, 55, 200)`,
      [firmAId, fixtureHourA],
    );
    await admin.query(
      `INSERT INTO usage_aggregates
         (firm_id, endpoint, hour, count, billable_count, p50_ms, p95_ms, p99_ms,
          avg_ms, max_ms)
       VALUES ($1, '/api/v1/sessions', $2, 200, 200, 60, 90, 120, 65, 250)`,
      [firmBId, fixtureHourB],
    );
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query(
        `DELETE FROM usage_aggregates WHERE firm_id = ANY($1) AND endpoint = '/api/v1/sessions'`,
        [[firmAId, firmBId]],
      );
      await admin.query('DELETE FROM usage_events WHERE id = ANY($1)', [
        [eventAId, eventBId],
      ]);
      await admin.query('DELETE FROM api_keys WHERE id = ANY($1)', [
        [apiKeyAId, apiKeyBId],
      ]);
      await admin.query('DELETE FROM firms WHERE id = ANY($1)', [[firmAId, firmBId]]);
      await admin.end();
    }
    if (app !== undefined) {
      await app.end();
    }
  });

  // ---------------------------------------------------------------------------
  // usage_events
  // ---------------------------------------------------------------------------

  it('usage_events: returns 0 rows from app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM usage_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('usage_events: returns only firm A events when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: number }>(
        'SELECT id FROM usage_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([eventAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('usage_events: app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO usage_events
             (firm_id, api_key_id, endpoint, method, status_code, latency_ms, request_id)
           VALUES ($1, $2, '/api/v1/sessions', 'POST', 200, 50, gen_random_uuid())`,
          [firmBId, apiKeyBId],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already rolled back
      }
      client.release();
    }
  });

  it('usage_events: admin pool can INSERT cross-firm (BYPASSRLS rollup worker path)', async () => {
    // The PLAN.md step 11 hourly rollup worker (not yet wired
    // into instrumentation.ts) processes every firm's events in
    // one pass through the admin pool. This pin guards routing
    // against accidental app-pool routing once the worker lands.
    const result = await admin.query<{ id: number }>(
      `INSERT INTO usage_events
         (firm_id, api_key_id, endpoint, method, status_code, latency_ms, request_id)
       VALUES ($1, $2, '/api/v1/health', 'GET', 200, 5, gen_random_uuid())
       RETURNING id`,
      [firmBId, apiKeyBId],
    );
    expect(result.rowCount).toBe(1);
    if (result.rows[0] !== undefined) {
      await admin.query('DELETE FROM usage_events WHERE id = $1', [result.rows[0].id]);
    }
  });

  // ---------------------------------------------------------------------------
  // usage_aggregates
  // ---------------------------------------------------------------------------

  it('usage_aggregates: returns 0 rows from app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        `SELECT count FROM usage_aggregates WHERE firm_id = ANY($1)`,
        [[firmAId, firmBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('usage_aggregates: returns only firm A aggregates when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ firm_id: string; count: string }>(
        `SELECT firm_id, count FROM usage_aggregates WHERE firm_id = ANY($1)`,
        [[firmAId, firmBId]],
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.firm_id).toBe(firmAId);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('usage_aggregates: admin pool can INSERT cross-firm (BYPASSRLS rollup worker path)', async () => {
    // Hourly rollup writes per-firm aggregates from cross-firm
    // event scans. Same BYPASSRLS contract as usage_events INSERT.
    const altHour = new Date('2026-04-25T11:00:00Z');
    const result = await admin.query(
      `INSERT INTO usage_aggregates
         (firm_id, endpoint, hour, count, billable_count, p50_ms, p95_ms, p99_ms,
          avg_ms, max_ms)
       VALUES ($1, '/api/v1/sessions', $2, 50, 50, 40, 70, 90, 45, 150)`,
      [firmBId, altHour],
    );
    expect(result.rowCount).toBe(1);
    await admin.query(
      `DELETE FROM usage_aggregates WHERE firm_id = $1 AND hour = $2`,
      [firmBId, altHour],
    );
  });

  it('usage_aggregates: app pool UPDATE on a foreign firm row affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE usage_aggregates SET count = 9999 WHERE firm_id = $1`,
        [firmBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene
  // ---------------------------------------------------------------------------

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const inside = await client.query<{ id: number }>(
        'SELECT id FROM usage_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([eventAId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM usage_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
