// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 7 integration test for the `firms` table.
 *
 * Mock-DB unit tests cannot exercise Postgres Row-Level Security: the
 * policies live in the database, not in any TypeScript layer we control.
 * This file therefore connects to the live local Postgres via two
 * `pg.Pool` instances — one as `crivacy_admin` (BYPASSRLS, used to
 * stage and tear down fixtures), one as `crivacy_app` (NOBYPASSRLS,
 * the role every dashboardRoute / apiRoute handler runs against in
 * production) — and asserts the actual policy behaviour that the
 * migration `20260425130000_rls_firms.sql` is supposed to enforce.
 *
 * The suite skips cleanly when the required environment variables are
 * unset (CI without a Postgres service, fresh checkouts that have not
 * configured the dev DB yet) so it never fails in environments where
 * RLS cannot be exercised.
 *
 * Each fixture firm is given a UUID-suffixed slug so concurrent test
 * runs and stale rows from previous runs cannot collide. `afterAll`
 * removes the test rows via the admin pool (BYPASSRLS) so we never
 * rely on the policy under test for teardown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

// Admin connection string follows the same precedence as
// `getDatabaseClient()`: prefer `DATABASE_URL_ADMIN` (Faz 4.5
// explicit binding), fall back to `DATABASE_URL` (back-compat). When
// both are set, the explicit binding wins so this suite tests the
// production-grade path whenever the operator has wired it up.
const ADMIN_URL =
  process.env['DATABASE_URL_ADMIN'] !== undefined &&
  process.env['DATABASE_URL_ADMIN'].length > 0
    ? process.env['DATABASE_URL_ADMIN']
    : process.env['DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL_APP'];

// Run only when both pools are configured. Without the app pool there
// is no way to drive a NOBYPASSRLS connection through the policy; the
// suite would silently exercise the admin pool and report green for
// the wrong reason. `describe.skipIf` keeps the rest of the test
// matrix green on CI runners that intentionally omit a Postgres
// service.
const RUN_RLS_TESTS =
  ADMIN_URL !== undefined && ADMIN_URL.length > 0 && APP_URL !== undefined && APP_URL.length > 0;

describe.skipIf(!RUN_RLS_TESTS)('RLS — firms (Cat 34b Faz 7)', () => {
  // Fresh suffix per test run so concurrent vitest workers and
  // leftover rows from a previous failure cannot collide.
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-a`;
  const slugB = `${suffix}-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    // Stage two firms via the admin pool. The migration revokes
    // INSERT on `firms` from crivacy_app, so the only legal way to
    // create rows is from a BYPASSRLS connection — which mirrors the
    // production split (firm provisioning is an admin flow).
    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;
  });

  afterAll(async () => {
    // Use admin (BYPASSRLS) — the migration revokes DELETE from the
    // app role anyway, so teardown via `app` would always fail.
    if (admin !== undefined) {
      await admin.query('DELETE FROM firms WHERE slug = ANY($1)', [[slugA, slugB]]);
      await admin.end();
    }
    if (app !== undefined) {
      await app.end();
    }
  });

  // ---------------------------------------------------------------------------
  // SELECT visibility
  // ---------------------------------------------------------------------------

  it('returns 0 rows from the app pool when app.firm_id is unset', async () => {
    // No `set_config` here — we rely on `current_setting('app.firm_id', true)`
    // returning NULL on the missing GUC and the comparison `id = NULL`
    // evaluating to NULL, which the policy treats as a non-match. If
    // this ever returns >0 rows, either the policy is misconfigured
    // or the role unexpectedly carries BYPASSRLS — both are critical
    // regressions.
    const client = await app.connect();
    try {
      const { rowCount } = await client.query('SELECT id FROM firms');
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A from the app pool when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>('SELECT id FROM firms');
      expect(result.rows.map((r) => r.id)).toEqual([firmAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B from the app pool when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>('SELECT id FROM firms');
      expect(result.rows.map((r) => r.id)).toEqual([firmBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture rows (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string }>(
      'SELECT id FROM firms WHERE id IN ($1, $2) ORDER BY id',
      [firmAId, firmBId],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([firmAId, firmBId]));
  });

  it('admin pool returns every firm under an unscoped SELECT (worker / migration pattern)', async () => {
    // pg-boss workers and the migration runner connect through the
    // admin pool (`getDatabaseClient().pool`) and routinely issue
    // queries with neither a `SET LOCAL app.firm_id` nor a
    // `WHERE firm_id = ...` clause — there is no firm context in a
    // background job. Under FORCE ROW LEVEL SECURITY this only works
    // because the admin connection role carries BYPASSRLS. If a
    // future ops change drops that attribute, this test goes red
    // before the migration prelude guard would and immediately
    // points at the regression.
    const result = await admin.query<{ id: string }>('SELECT id FROM firms');
    // At minimum the two fixtures plus whatever real dev rows
    // exist; the exact total depends on the seed state, which is
    // why the assertion is `>= 2` rather than `=== 2`.
    expect(result.rowCount ?? 0).toBeGreaterThanOrEqual(2);
    const visible = new Set(result.rows.map((r) => r.id));
    expect(visible.has(firmAId)).toBe(true);
    expect(visible.has(firmBId)).toBe(true);
  });

  it('admin pool ignores stray app.firm_id (BYPASSRLS dominates the policy)', async () => {
    // Defensive scenario: imagine a future bug where some shared
    // helper accidentally calls `set_config('app.firm_id', ...)` on
    // an admin-pool transaction. BYPASSRLS still wins — the policy
    // never evaluates — so admin queries continue to return every
    // row. Codifying this means a future Postgres release that
    // changes BYPASSRLS precedence would surface as a test failure
    // here rather than silently shrinking admin result sets in
    // production.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>('SELECT id FROM firms');
      expect(result.rowCount ?? 0).toBeGreaterThanOrEqual(2);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // UPDATE behaviour — USING + WITH CHECK
  // ---------------------------------------------------------------------------

  it('app pool can UPDATE its own firm row (USING matches)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE firms SET notes = 'self-update-ok' WHERE id = $1`,
        [firmAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      // Caller authenticated as firm A, attempts to mutate firm B.
      // RLS USING clause prevents the row from being seen at all, so
      // the UPDATE matches nothing and returns rowCount = 0 — no
      // error, just a silent no-op (the right behaviour, since
      // surfacing an error here would also confirm the row exists
      // for an attacker probing).
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE firms SET notes = 'cross-firm-attack' WHERE id = $1`,
        [firmBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE that rewrites id to another firm fails the WITH CHECK', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      // Without WITH CHECK, this UPDATE would succeed: USING matches
      // the original row (id = firmAId), and the new value (id =
      // firmBId) would land under another tenant. WITH CHECK
      // re-validates the post-image and blocks the move.
      await expect(
        client.query(`UPDATE firms SET id = $1 WHERE id = $2`, [firmBId, firmAId]),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // INSERT / DELETE — privilege revoke
  // ---------------------------------------------------------------------------

  it('app pool INSERT is rejected at the privilege layer', async () => {
    // The migration revokes INSERT entirely from crivacy_app, so
    // this fails with `permission denied for table firms` BEFORE
    // RLS would even evaluate the row. Any policy that weakened
    // this would let a handler create cross-tenant firms — the
    // REVOKE keeps the failure mode loud and obvious.
    await expect(
      app.query(
        `INSERT INTO firms (name, slug, contact_email)
         VALUES ($1, $2, $3)`,
        ['hacker firm', `${suffix}-hacker`, 'h@example.test'],
      ),
    ).rejects.toThrow(/permission denied for table firms/i);
  });

  it('app pool DELETE is rejected at the privilege layer', async () => {
    await expect(
      app.query('DELETE FROM firms WHERE id = $1', [firmAId]),
    ).rejects.toThrow(/permission denied for table firms/i);
  });

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Faz 4.5 invariant — admin role identity
  // ---------------------------------------------------------------------------

  it('admin pool connects as a role that carries BYPASSRLS', async () => {
    // The whole RLS scheme assumes the admin pool's current_user
    // carries the BYPASSRLS attribute — that's the invariant the
    // Faz 7 migration prelude guards. Faz 4.5 was supposed to make
    // this hold by binding the admin pool to a dedicated
    // `crivacy_admin` role with the attribute baked in. If a future
    // ops change re-points DATABASE_URL_ADMIN at a NOBYPASSRLS role
    // (or strips the attribute from `crivacy_admin`), this test
    // surfaces the regression in CI before it lands in prod, where
    // the symptom would be silent BYPASSRLS-less admin queries
    // returning zero firm rows.
    const result = await admin.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.rolbypassrls).toBe(true);
  });

  it('app pool connects as a role that does NOT carry BYPASSRLS', async () => {
    // Mirror invariant: the app pool MUST be NOBYPASSRLS, otherwise
    // every policy is bypassed and cross-firm IDOR comes back via
    // the handler surface. Future ops mistakes (eg. accidentally
    // pointing DATABASE_URL_APP at the admin role) are caught here.
    const result = await app.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      // Set firm A inside one tx.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const inside = await client.query<{ id: string }>('SELECT id FROM firms');
      expect(inside.rows.map((r) => r.id)).toEqual([firmAId]);
      await client.query('COMMIT');

      // After commit, the same checked-out client must see 0 rows
      // again — `SET LOCAL` is documented to clear at transaction
      // end. If a future Postgres / PgBouncer config breaks this,
      // the next request on a recycled connection would inherit the
      // previous request's tenant context. This assertion is the
      // canary for that scenario.
      const after = await client.query('SELECT id FROM firms');
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
