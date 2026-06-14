// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 15b integration test for the
 * `firm_users` table. The TWELFTH and FINAL firm-scoped table
 * to come under RLS — with this suite green, Cat 34b DB-01 is
 * closed end-to-end.
 *
 * firm_users is the dashboard authentication backbone. The
 * suite covers the unique pre-auth pattern: login flow looks up
 * a user by email + bumps failed_login_count BEFORE any session
 * is minted, so those paths MUST keep working through the
 * admin pool (BYPASSRLS). Post-auth firm-team operations
 * (role change, member remove) run on the app pool with
 * app.firm_id set; cross-firm probes are gated by the policy.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — firm_users (Cat 34b Faz 15b)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-fu-a`;
  const slugB = `${suffix}-fu-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS FirmUser Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS FirmUser Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    const uA = await admin.query<{ id: string }>(
      `INSERT INTO firm_users (firm_id, email, password_hash, role)
       VALUES ($1, $2, '$argon2id$v=19$m=65536,t=3,p=4$placeholder', 'owner')
       RETURNING id`,
      [firmAId, `owner-${suffix}-a@example.test`],
    );
    const uB = await admin.query<{ id: string }>(
      `INSERT INTO firm_users (firm_id, email, password_hash, role)
       VALUES ($1, $2, '$argon2id$v=19$m=65536,t=3,p=4$placeholder', 'owner')
       RETURNING id`,
      [firmBId, `owner-${suffix}-b@example.test`],
    );
    userAId = uA.rows[0]!.id;
    userBId = uB.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query('DELETE FROM firm_users WHERE id = ANY($1)', [
        [userAId, userBId],
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
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM firm_users WHERE id = ANY($1)',
        [[userAId, userBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A users when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM firm_users WHERE id = ANY($1)',
        [[userAId, userBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([userAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture users (BYPASSRLS — pre-auth firmUserLookup)', async () => {
    // dashboard-route.ts middleware looks users up by id from the
    // admin pool BEFORE binding the request to a firm. This pin
    // guards against future routing changes that would silently
    // break dashboard authentication.
    const result = await admin.query<{ id: string }>(
      'SELECT id FROM firm_users WHERE id = ANY($1) ORDER BY id',
      [[userAId, userBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([userAId, userBId]));
  });

  // ---------------------------------------------------------------------------
  // Login flow pre-auth — email → user lookup + failed_login_count UPDATE
  // ---------------------------------------------------------------------------

  it('admin pool can SELECT firm_user by email cross-firm (BYPASSRLS login lookup)', async () => {
    // dashboard-auth.ts::handleLogin first runs `SELECT ... FROM
    // firm_users WHERE lower(email) = lower($1)`. That query
    // doesn't carry a firm_id WHERE because the firm context is
    // unknown at login time. BYPASSRLS lets the lookup return
    // any firm's user row. Test pins the contract.
    const result = await admin.query<{ id: string; firm_id: string }>(
      `SELECT id, firm_id FROM firm_users WHERE lower(email) = lower($1)`,
      [`owner-${suffix}-b@example.test`],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.id).toBe(userBId);
    expect(result.rows[0]!.firm_id).toBe(firmBId);
  });

  it('admin pool can UPDATE failed_login_count cross-firm (BYPASSRLS login attempt counter)', async () => {
    // Login handler increments failed_login_count after a
    // wrong-password attempt — BEFORE any session minted, so
    // app.firm_id has not been set. The UPDATE issues
    // `SET failed_login_count = N WHERE id = $userId` (no
    // firm_id WHERE). BYPASSRLS keeps it working.
    const result = await admin.query(
      `UPDATE firm_users SET failed_login_count = 1 WHERE id = $1`,
      [userBId],
    );
    expect(result.rowCount).toBe(1);
    // Reset for downstream assertions / tests that read this row.
    await admin.query(`UPDATE firm_users SET failed_login_count = 0 WHERE id = $1`, [
      userBId,
    ]);
  });

  // ---------------------------------------------------------------------------
  // Post-auth firm-team operations
  // ---------------------------------------------------------------------------

  it('app pool can UPDATE its own firm user (USING + WITH CHECK match)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE firm_users SET role = 'admin' WHERE id = $1`,
        [userAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm user affects 0 rows (USING blocks)', async () => {
    // firm-team.ts::handleChangeFirmUserRole has a Cat 22
    // application-layer firm-scope check, but the policy USING
    // is the database-layer guarantee. If a future change drops
    // the application check, RLS still gates the cross-tenant
    // role-change attempt to 0 rows.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE firm_users SET role = 'viewer' WHERE id = $1`,
        [userBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool DELETE on a foreign firm user affects 0 rows (USING blocks)', async () => {
    // firm-team.ts::handleRemoveFirmTeammate hard-deletes; cross-
    // firm attempt must affect 0 rows.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM firm_users WHERE id = $1`, [
        userBId,
      ]);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO firm_users (firm_id, email, password_hash, role)
           VALUES ($1, $2, '$argon2id$placeholder', 'member')`,
          [firmBId, `attacker-${suffix}@example.test`],
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

  it('app pool UPDATE that re-homes firm_id fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(`UPDATE firm_users SET firm_id = $1 WHERE id = $2`, [
          firmBId,
          userAId,
        ]),
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

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene
  // ---------------------------------------------------------------------------

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const inside = await client.query<{ id: string }>(
        'SELECT id FROM firm_users WHERE id = ANY($1)',
        [[userAId, userBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([userAId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM firm_users WHERE id = ANY($1)',
        [[userAId, userBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
