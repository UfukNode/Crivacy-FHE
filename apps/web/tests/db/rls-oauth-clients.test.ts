// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 9 integration test for the
 * `oauth_clients` table.
 *
 * Mock-DB unit tests cannot exercise Postgres Row-Level Security:
 * the policies live in the database, not in any TypeScript layer
 * we control. This file connects to the live local Postgres via two
 * `pg.Pool` instances — one as `crivacy_admin` (BYPASSRLS, used to
 * stage and tear down fixtures and to simulate the OAuth public
 * endpoints' pre-auth lookup path), one as `crivacy_app`
 * (NOBYPASSRLS, the role every dashboardRoute / apiRoute handler
 * runs against in production) — and asserts the policy behaviour
 * that the migration `20260425150000_rls_oauth_clients.sql` is
 * supposed to enforce.
 *
 * Symmetric to `rls-api-keys.test.ts` (Faz 8). Both tables share
 * the same shape (firm_id FK, FOR ALL policy, INSERT + DELETE
 * granted to crivacy_app for self-service CRUD), so the assertion
 * matrix mirrors Faz 8 with one extra contract pin: the pre-auth
 * `failedSecretAttempts` UPDATE that runs on the admin pool from
 * `oauth-token.ts` MUST keep working under FORCE ROW LEVEL SECURITY.
 *
 * The suite skips cleanly when the required env vars are unset (CI
 * without a Postgres service, fresh checkouts) so it never fails
 * where RLS cannot be exercised. Each fixture firm is given a
 * UUID-suffixed slug to avoid collisions across concurrent test
 * runs and stale rows from a previous failure. `afterAll` removes
 * the test rows via the admin pool (BYPASSRLS) so we never rely on
 * the policy under test for teardown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

// Same precedence as `getDatabaseClient()`, `rls-firms.test.ts`,
// and `rls-api-keys.test.ts`: prefer the explicit Faz 4.5 admin
// binding, fall back to the back-compat single-role connection.
const ADMIN_URL =
  process.env['DATABASE_URL_ADMIN'] !== undefined &&
  process.env['DATABASE_URL_ADMIN'].length > 0
    ? process.env['DATABASE_URL_ADMIN']
    : process.env['DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL_APP'];

const RUN_RLS_TESTS =
  ADMIN_URL !== undefined && ADMIN_URL.length > 0 && APP_URL !== undefined && APP_URL.length > 0;

describe.skipIf(!RUN_RLS_TESTS)('RLS — oauth_clients (Cat 34b Faz 9)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-oauth-a`;
  const slugB = `${suffix}-oauth-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let clientAId: string;
  let clientBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    // Stage two firms via the admin pool (Faz 7 revokes INSERT on
    // `firms` from crivacy_app, so this is the only legal way to
    // create rows). Each firm gets one fixture oauth_clients row
    // staged through the admin pool too — that mirrors the runtime
    // pre-auth lookup path which reads via `getDatabaseClient().db`
    // (admin alias) before any `SET LOCAL app.firm_id` could scope
    // the connection.
    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS OAuth Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS OAuth Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    // `client_id` is `varchar(64)` and globally unique-indexed —
    // two fixture clients use a per-suffix prefix to stay clear of
    // each other and of any real dev rows. `name` is `varchar(128)`.
    // The bcrypt hash is a synthetic placeholder; bcrypt verify is
    // never invoked by this suite, only RLS visibility / mutation
    // gating.
    const ca = await admin.query<{ id: string }>(
      `INSERT INTO oauth_clients (firm_id, client_id, client_secret_hash, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [firmAId, `crv_oauth_${suffix}_a`, '$2b$04$placeholderhashA', 'fixture-a'],
    );
    const cb = await admin.query<{ id: string }>(
      `INSERT INTO oauth_clients (firm_id, client_id, client_secret_hash, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [firmBId, `crv_oauth_${suffix}_b`, '$2b$04$placeholderhashB', 'fixture-b'],
    );
    clientAId = ca.rows[0]!.id;
    clientBId = cb.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      // oauth_clients cascades from firms via the firm_id FK with
      // onDelete: 'cascade', so removing the fixture firms also
      // removes their clients. Belt-and-suspenders: also try to
      // remove clients directly in case a future change loosens
      // the cascade.
      await admin.query('DELETE FROM oauth_clients WHERE id = ANY($1)', [
        [clientAId, clientBId],
      ]);
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
    // Same NULLIF guard rationale as Faz 7+8 — missing GUC ⇒ NULL
    // via NULLIF, `firm_id = NULL` ⇒ NULL ⇒ row excluded. The query
    // does NOT raise; an attacker probing through a forgotten SET
    // LOCAL learns nothing.
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM oauth_clients WHERE id = ANY($1)',
        [[clientAId, clientBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A clients from the app pool when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM oauth_clients WHERE id = ANY($1)',
        [[clientAId, clientBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([clientAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B clients from the app pool when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM oauth_clients WHERE id = ANY($1)',
        [[clientAId, clientBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([clientBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture clients (BYPASSRLS)', async () => {
    // Pre-auth `findOauthClientByClientId(db, clientId)` runs on
    // the admin pool — it must, because the firm context is not
    // yet known when `/oauth/authorize?client_id=...` first lands.
    // This assertion confirms the admin pool keeps that path
    // working under RLS.
    const result = await admin.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM oauth_clients WHERE id = ANY($1) ORDER BY id',
      [[clientAId, clientBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([clientAId, clientBId]));
  });

  // ---------------------------------------------------------------------------
  // INSERT — WITH CHECK behaviour
  // ---------------------------------------------------------------------------

  it('app pool can INSERT a client for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO oauth_clients (firm_id, client_id, client_secret_hash, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [firmAId, `crv_self_${Date.now().toString(36).slice(0, 8)}`, '$2b$04$x', 'self-insert'],
      );
      expect(result.rowCount).toBe(1);
      // Roll back — fixture state stays clean for downstream tests.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    // Attacker authenticated as firm A attempts to mint an OAuth
    // client naming firm B. WITH CHECK validates the post-image
    // and rejects the row before it lands. This is the defence the
    // Cat 22 IDOR audit relied on at the application layer for
    // dashboard create/update; RLS makes it a database-level
    // invariant.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO oauth_clients (firm_id, client_id, client_secret_hash, name)
           VALUES ($1, $2, $3, $4)`,
          [firmBId, `crv_xt_${Date.now().toString(36).slice(0, 8)}`, '$2b$04$x', 'cross-tenant'],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT with no app.firm_id set fails the WITH CHECK clause', async () => {
    // Forgotten SET LOCAL ⇒ NULLIF → NULL ⇒ `firm_id = NULL` ⇒
    // NULL ⇒ check fails closed. This stops a future middleware
    // bug (eg. handler called outside the tx wrapper) from
    // silently writing rows that bypass tenant scoping.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      // Intentionally no `set_config('app.firm_id', ...)` here.
      await expect(
        client.query(
          `INSERT INTO oauth_clients (firm_id, client_id, client_secret_hash, name)
           VALUES ($1, $2, $3, $4)`,
          [firmAId, `crv_un_${Date.now().toString(36).slice(0, 8)}`, '$2b$04$x', 'unset'],
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

  it('app pool can UPDATE its own client (USING + WITH CHECK match)', async () => {
    // Mirrors the dashboard rotate-secret / patch / revoke paths,
    // which call `db.update(oauthClients)` inside the handler tx.
    // Note: `handleDashboardRotateOauthClientSecret` issues
    // `UPDATE ... WHERE id = $1` WITHOUT a `firm_id = $2` predicate
    // (it relies on a SELECT pre-check). Once this policy is live,
    // the missing WHERE is closed at the DB level — see the comment
    // block in the migration for the full rationale. This assertion
    // pins the "own firm UPDATE works" half of that contract.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE oauth_clients SET name = 'self-update-ok' WHERE id = $1`,
        [clientAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm client affects 0 rows (USING blocks)', async () => {
    // Defense-in-depth pin for the Cat 22 IDOR + Faz 9 follow-up:
    // even if a future code change drops `eq(firmId)` from the
    // application-layer WHERE (or the existing rotate-secret bug
    // is hit through a race-window hijack), the policy USING
    // clause filters the row out of the UPDATE's row-set entirely
    // so rowCount is 0 — no error raised, mirroring the Faz 7+8
    // invariant that probing cross-tenant rows tells the attacker
    // nothing about their existence.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE oauth_clients SET name = 'cross-firm-attack' WHERE id = $1`,
        [clientBId],
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
    // same defence Faz 7+8 set up for `firms.id` and `api_keys.firm_id`.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(`UPDATE oauth_clients SET firm_id = $1 WHERE id = $2`, [
          firmBId,
          clientAId,
        ]),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE — USING behaviour (privilege still granted, like api_keys)
  // ---------------------------------------------------------------------------

  it('app pool can DELETE its own client', async () => {
    // The repository today implements revoke as a soft-delete
    // UPDATE (`revoked_at = now()`), so this code path is never
    // exercised in production — but the privilege grant + policy
    // are defense-in-depth for any future hard-delete that lands
    // without re-thinking RLS. This assertion locks that in.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM oauth_clients WHERE id = $1`, [
        clientAId,
      ]);
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool DELETE on a foreign firm client affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM oauth_clients WHERE id = $1`, [
        clientBId,
      ]);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Pre-auth contract pins — admin pool BYPASSRLS UPDATE
  // ---------------------------------------------------------------------------

  it('admin pool can UPDATE failed_secret_attempts on any firm client (BYPASSRLS pre-auth path)', async () => {
    // `oauth-token.ts:251/308/322` issues a fire-and-forget UPDATE
    // setting `failed_secret_attempts = N` (and `secret_locked_until`
    // when N hits the threshold) on the client row identified by the
    // submitted `client_id`. That happens BEFORE the handler tx
    // scopes `app.firm_id` — by design, because the bcrypt verify
    // itself is the gate that establishes firm context. The UPDATE
    // therefore goes through `getDatabaseClient().db` (admin pool
    // alias). If a future change accidentally routes that UPDATE
    // through the app pool, the policy would block it (no SET
    // LOCAL set yet) and lockout tracking would silently break,
    // turning the brute-force defence into a no-op. This test
    // pins the contract.
    const result = await admin.query(
      `UPDATE oauth_clients SET failed_secret_attempts = 1 WHERE id = $1`,
      [clientBId],
    );
    expect(result.rowCount).toBe(1);
  });

  it('admin pool can UPDATE secret_locked_until on any firm client (BYPASSRLS pre-auth path)', async () => {
    // Companion contract to the failed_secret_attempts pin:
    // when the lockout threshold is reached, `oauth-token.ts:253`
    // also stamps `secret_locked_until` in the same UPDATE. The
    // assertion above only checks the counter column — this one
    // confirms the timestamp column also takes the BYPASSRLS write,
    // so a partial column-grant misconfiguration shows up in CI
    // before it breaks production lockout tracking.
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    const result = await admin.query(
      `UPDATE oauth_clients SET secret_locked_until = $1 WHERE id = $2`,
      [lockedUntil, clientBId],
    );
    expect(result.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene
  // ---------------------------------------------------------------------------

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      // Set firm A inside one tx and observe its own clients.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const inside = await client.query<{ id: string }>(
        'SELECT id FROM oauth_clients WHERE id = ANY($1)',
        [[clientAId, clientBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([clientAId]);
      await client.query('COMMIT');

      // After commit the same checked-out client must see 0 rows
      // again — `SET LOCAL` clears at transaction end. If a future
      // Postgres / PgBouncer config breaks this, the next request
      // on a recycled connection would inherit the previous
      // request's tenant context.
      const after = await client.query(
        'SELECT id FROM oauth_clients WHERE id = ANY($1)',
        [[clientAId, clientBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
