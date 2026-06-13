// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 8 integration test for the `api_keys`
 * table.
 *
 * Mock-DB unit tests cannot exercise Postgres Row-Level Security: the
 * policies live in the database, not in any TypeScript layer we
 * control. This file connects to the live local Postgres via two
 * `pg.Pool` instances — one as `crivacy_admin` (BYPASSRLS, used to
 * stage and tear down fixtures and to simulate the pre-auth lookup
 * path that runs on the admin pool), one as `crivacy_app`
 * (NOBYPASSRLS, the role every dashboardRoute / apiRoute handler runs
 * against in production) — and asserts the policy behaviour that the
 * migration `20260425140000_rls_api_keys.sql` is supposed to enforce.
 *
 * Differences from `rls-firms.test.ts` (Faz 7):
 *
 *   - `firms` policies were SELECT + UPDATE only (firm provisioning
 *     is admin-only, INSERT + DELETE were revoked at the privilege
 *     layer). `api_keys` keeps INSERT + DELETE granted to crivacy_app
 *     because the dashboard endpoint
 *     `POST /api/internal/api-keys` lets a firm self-create keys.
 *     The cross-tenant write defence therefore lives in the policy's
 *     WITH CHECK clause rather than a REVOKE, and the suite exercises
 *     it explicitly.
 *   - The `firm_id` column is a foreign key (not the table's own
 *     `id`), so the WITH CHECK can fail in two distinct ways:
 *     `firm_id = <other-firm>` (cross-tenant insert) and
 *     `firm_id = NULL` (forgotten or stale `app.firm_id`). Both are
 *     covered.
 *
 * The suite skips cleanly when the required env vars are unset (CI
 * without a Postgres service, fresh checkouts) so it never fails
 * where RLS cannot be exercised. Each fixture firm is given a UUID-
 * suffixed slug to avoid collisions across concurrent test runs and
 * stale rows from a previous failure. `afterAll` removes the test
 * rows via the admin pool (BYPASSRLS) so we never rely on the
 * policy under test for teardown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

// Same precedence as `getDatabaseClient()` and `rls-firms.test.ts`:
// prefer the explicit Faz 4.5 admin binding, fall back to the
// back-compat single-role connection.
const ADMIN_URL =
  process.env['DATABASE_URL_ADMIN'] !== undefined &&
  process.env['DATABASE_URL_ADMIN'].length > 0
    ? process.env['DATABASE_URL_ADMIN']
    : process.env['DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL_APP'];

const RUN_RLS_TESTS =
  ADMIN_URL !== undefined && ADMIN_URL.length > 0 && APP_URL !== undefined && APP_URL.length > 0;

describe.skipIf(!RUN_RLS_TESTS)('RLS — api_keys (Cat 34b Faz 8)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-keys-a`;
  const slugB = `${suffix}-keys-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let keyAId: string;
  let keyBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    // Stage two firms via the admin pool (Faz 7 revokes INSERT on
    // `firms` from crivacy_app, so this is the only legal way to
    // create rows). Each firm gets one fixture api_keys row staged
    // through the admin pool too — that path mirrors the runtime
    // pre-auth flow which writes via `getDatabaseClient().db` (admin
    // alias) before the handler tx scopes `app.firm_id`.
    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS API-Key Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS API-Key Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    // Two fixture api_keys rows. `prefix` is `varchar(12)` and
    // unique-indexed, so the suffix is truncated to fit. `mode`
    // matches the apiKeyModeEnum ('live' | 'test'). The hash is a
    // synthetic placeholder — bcrypt verification is never invoked
    // by this suite, only RLS visibility / mutation gating.
    const ka = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, $3, $4, 'live')
       RETURNING id`,
      [firmAId, `crv_a_${suffix.slice(0, 6)}`, '$2b$04$placeholderhashA', 'fixture-a'],
    );
    const kb = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, $3, $4, 'live')
       RETURNING id`,
      [firmBId, `crv_b_${suffix.slice(0, 6)}`, '$2b$04$placeholderhashB', 'fixture-b'],
    );
    keyAId = ka.rows[0]!.id;
    keyBId = kb.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      // api_keys cascades from firms via the firm_id FK with
      // onDelete: 'cascade', so removing the fixture firms also
      // removes their keys. Belt-and-suspenders: also try to remove
      // keys directly in case a future change loosens the cascade.
      await admin.query('DELETE FROM api_keys WHERE id = ANY($1)', [[keyAId, keyBId]]);
      await admin.query('DELETE FROM firms WHERE id = ANY($1)', [[firmAId, firmBId]]);
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
    // Same NULLIF guard rationale as Faz 7 — missing GUC ⇒ NULL via
    // NULLIF, `firm_id = NULL` ⇒ NULL ⇒ row excluded. The query
    // does NOT raise; an attacker probing through a forgotten SET
    // LOCAL learns nothing.
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM api_keys WHERE id = ANY($1)',
        [[keyAId, keyBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A keys from the app pool when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM api_keys WHERE id = ANY($1)',
        [[keyAId, keyBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([keyAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B keys from the app pool when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM api_keys WHERE id = ANY($1)',
        [[keyAId, keyBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([keyBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture keys (BYPASSRLS)', async () => {
    // Pre-auth `auth-lookup.ts::buildAuthLookup` runs prefix lookup
    // on the admin pool — it has to, because the firm context is
    // not yet known at that stage. This assertion confirms the
    // admin pool keeps that path working under RLS.
    const result = await admin.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM api_keys WHERE id = ANY($1) ORDER BY id',
      [[keyAId, keyBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([keyAId, keyBId]));
  });

  // ---------------------------------------------------------------------------
  // INSERT — WITH CHECK behaviour
  // ---------------------------------------------------------------------------

  it('app pool can INSERT a key for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
         VALUES ($1, $2, $3, $4, 'live')
         RETURNING id`,
        [firmAId, `crv_a_${Date.now().toString(36).slice(0, 5)}`, '$2b$04$x', 'self-insert'],
      );
      expect(result.rowCount).toBe(1);
      // Roll back — fixture state stays clean for downstream tests.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    // Attacker is authenticated as firm A, attempts to mint an api
    // key naming firm B. WITH CHECK validates the post-image and
    // rejects the row before it lands. This is the defence the
    // Cat 22 IDOR audit relied on at the application layer; RLS
    // makes it a database-level invariant.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
           VALUES ($1, $2, $3, $4, 'live')`,
          [firmBId, `crv_xt_${Date.now().toString(36).slice(0, 5)}`, '$2b$04$x', 'cross-tenant'],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT with no app.firm_id set fails the WITH CHECK clause', async () => {
    // Forgotten SET LOCAL ⇒ NULLIF → NULL ⇒ `firm_id = NULL` ⇒
    // NULL ⇒ check fails closed. This is what stops a future
    // middleware bug (eg. handler called outside the tx wrapper)
    // from silently writing rows that bypass tenant scoping.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      // Intentionally no `set_config('app.firm_id', ...)` here.
      await expect(
        client.query(
          `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
           VALUES ($1, $2, $3, $4, 'live')`,
          [firmAId, `crv_un_${Date.now().toString(36).slice(0, 5)}`, '$2b$04$x', 'unset'],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // UPDATE — USING + WITH CHECK behaviour
  // ---------------------------------------------------------------------------

  it('app pool can UPDATE its own key (USING + WITH CHECK match)', async () => {
    // Mirrors the dashboard rotate / revoke paths, which call
    // `db.update(apiKeys).where(and(eq(id, ...), eq(firmId, ...)))`
    // inside the handler tx. The repository's WHERE is now redundant
    // with the policy USING but stays as defense-in-depth.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE api_keys SET name = 'self-update-ok' WHERE id = $1`,
        [keyAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm key affects 0 rows (USING blocks)', async () => {
    // Caller authenticated as firm A, attempts to mutate firm B's
    // key. USING filters the row out of the UPDATE's row-set
    // entirely so rowCount is 0 — no error is raised, mirroring
    // the Faz 7 firms invariant that probing cross-tenant rows
    // tells the attacker nothing about their existence.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE api_keys SET name = 'cross-firm-attack' WHERE id = $1`,
        [keyBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE that re-homes firm_id fails the WITH CHECK clause', async () => {
    // Without WITH CHECK, this UPDATE would succeed: USING matches
    // the original row (firm_id = firmAId), and the new value
    // (firm_id = firmBId) would land under another tenant. WITH
    // CHECK re-validates the post-image and blocks the move — the
    // same defence Faz 7 set up for `firms.id`.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(`UPDATE api_keys SET firm_id = $1 WHERE id = $2`, [firmBId, keyAId]),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE — USING behaviour (privilege still granted, unlike firms)
  // ---------------------------------------------------------------------------

  it('app pool can DELETE its own key', async () => {
    // The repository today implements revoke as a soft-delete
    // UPDATE (revoked_at = now()), so this code path is never
    // exercised in production — but the privilege grant + policy
    // are defense-in-depth for any future hard-delete that lands
    // without re-thinking RLS. This assertion locks that in.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM api_keys WHERE id = $1`, [keyAId]);
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool DELETE on a foreign firm key affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM api_keys WHERE id = $1`, [keyBId]);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Pre-auth simulation — admin pool fire-and-forget UPDATE
  // ---------------------------------------------------------------------------

  it('admin pool can UPDATE last_used_at on any firm key (BYPASSRLS pre-auth path)', async () => {
    // `auth-lookup.ts::buildAuthLookup` does a fire-and-forget
    // UPDATE setting `last_used_at = now()` on the row it just
    // resolved. That happens BEFORE the handler tx scopes
    // `app.firm_id`, so it has to run on the admin pool. If a
    // future change accidentally routes that UPDATE through the
    // app pool, the policy would block it (no SET LOCAL set yet)
    // and last_used_at would stop tracking. This test pins the
    // contract.
    const result = await admin.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [keyBId],
    );
    expect(result.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene
  // ---------------------------------------------------------------------------

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      // Set firm A inside one tx and observe its own keys.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const inside = await client.query<{ id: string }>(
        'SELECT id FROM api_keys WHERE id = ANY($1)',
        [[keyAId, keyBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([keyAId]);
      await client.query('COMMIT');

      // After commit the same checked-out client must see 0 rows
      // again — `SET LOCAL` clears at transaction end. If a future
      // Postgres / PgBouncer config breaks this the next request on
      // a recycled connection would inherit the previous request's
      // tenant context.
      const after = await client.query(
        'SELECT id FROM api_keys WHERE id = ANY($1)',
        [[keyAId, keyBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
