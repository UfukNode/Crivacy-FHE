// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 13 integration test for the
 * `audit_log` table.
 *
 * Seventh firm-scoped table. Schema is simpler than the plan
 * anticipated: a single nullable `firm_id` column, populated by
 * `lib/audit/writer.ts::buildInsertRow` with a fallback chain
 * (actor.firmId ?? targetFirm.id ?? null). The policy is the
 * standard single-column match.
 *
 * The interesting behaviour here is `firm_id IS NULL` rows
 * (system actors, customer-only events, admin actions on
 * non-firm targets, failed-auth pre-identity entries). The
 * policy correctly hides them from crivacy_app — `firm_id =
 * NULL` evaluates to NULL, the row is excluded — and the admin
 * pool BYPASSRLS keeps all the legitimate emit paths working.
 * Both halves are covered explicitly.
 *
 * audit_log is append-only by API contract; UPDATE/DELETE
 * scenarios are defense-in-depth.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — audit_log (Cat 34b Faz 13)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-aud-a`;
  const slugB = `${suffix}-aud-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let auditAFirmId: number;
  let auditBFirmId: number;
  let auditNullFirmId: number;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Audit Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Audit Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    // Three fixture audit rows: one for each firm + one with
    // firm_id NULL (system actor, no firm context). The third row
    // exercises the policy's NULL exclusion behaviour.
    const auditA = await admin.query<{ id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id, action, meta)
       VALUES ('firm_user', gen_random_uuid(), 'fixture-a@example.test', $1, 'firm.test', '{}'::jsonb)
       RETURNING id`,
      [firmAId],
    );
    const auditB = await admin.query<{ id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id, action, meta)
       VALUES ('firm_user', gen_random_uuid(), 'fixture-b@example.test', $1, 'firm.test', '{}'::jsonb)
       RETURNING id`,
      [firmBId],
    );
    const auditNull = await admin.query<{ id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_label, firm_id, action, meta)
       VALUES ('system', 'pg-boss-worker', NULL, 'system.test', '{}'::jsonb)
       RETURNING id`,
    );
    auditAFirmId = auditA.rows[0]!.id;
    auditBFirmId = auditB.rows[0]!.id;
    auditNullFirmId = auditNull.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query('DELETE FROM audit_log WHERE id = ANY($1)', [
        [auditAFirmId, auditBFirmId, auditNullFirmId],
      ]);
      // firm_id ON DELETE SET NULL on audit_log, so dropping the
      // fixture firms doesn't cascade — explicit firm cleanup.
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
        'SELECT id FROM audit_log WHERE id = ANY($1)',
        [[auditAFirmId, auditBFirmId, auditNullFirmId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A audit rows when app.firm_id = firmA (NULL firm rows excluded)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: number }>(
        'SELECT id FROM audit_log WHERE id = ANY($1) ORDER BY id',
        [[auditAFirmId, auditBFirmId, auditNullFirmId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([auditAFirmId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B audit rows when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: number }>(
        'SELECT id FROM audit_log WHERE id = ANY($1) ORDER BY id',
        [[auditAFirmId, auditBFirmId, auditNullFirmId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([auditBFirmId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('NULL firm_id rows are NEVER visible from the app pool (correct policy)', async () => {
    // Defensive pin: even with `app.firm_id` set to firm A, the
    // system row with firm_id = NULL stays out of the result. This
    // codifies the "NULL excluded" semantics of the policy — a
    // future change that flipped the predicate (e.g. `firm_id =
    // current_setting OR firm_id IS NULL`) would leak system audit
    // rows to firm dashboards. This assertion fails closed.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: number }>(
        'SELECT id FROM audit_log WHERE id = $1',
        [auditNullFirmId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees all three fixture audit rows including the NULL firm_id one (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: number; firm_id: string | null }>(
      'SELECT id, firm_id FROM audit_log WHERE id = ANY($1) ORDER BY id',
      [[auditAFirmId, auditBFirmId, auditNullFirmId]],
    );
    expect(result.rowCount).toBe(3);
    const idsWithNull = result.rows.filter((r) => r.firm_id === null).map((r) => r.id);
    expect(idsWithNull).toEqual([auditNullFirmId]);
  });

  // ---------------------------------------------------------------------------
  // INSERT — WITH CHECK behaviour
  // ---------------------------------------------------------------------------

  it('app pool can INSERT an audit row for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: number }>(
        `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id, action, meta)
         VALUES ('firm_user', gen_random_uuid(), 'self@example.test', $1, 'firm.test',
                 '{}'::jsonb)
         RETURNING id`,
        [firmAId],
      );
      expect(result.rowCount).toBe(1);
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

  it('app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id, action, meta)
           VALUES ('firm_user', gen_random_uuid(), 'attacker@example.test', $1,
                   'cross.tenant', '{}'::jsonb)`,
          [firmBId],
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

  it('app pool INSERT with NULL firm_id fails the WITH CHECK clause', async () => {
    // System / failed-auth audit emits land with firm_id = NULL.
    // Those paths run on the admin pool (BYPASSRLS), so this
    // assertion isn't a production scenario — it exists to prove
    // the policy fails closed if someone ever wires a system-actor
    // emit through a firm-scoped tx by accident.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO audit_log (actor_kind, actor_label, firm_id, action, meta)
           VALUES ('system', 'cross-pool-mistake', NULL, 'system.misroute',
                   '{}'::jsonb)`,
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

  // ---------------------------------------------------------------------------
  // UPDATE / DELETE — defense-in-depth (audit is append-only by API
  // contract; production code never updates or deletes)
  // ---------------------------------------------------------------------------

  it('app pool UPDATE on a foreign firm audit row affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE audit_log SET meta = '{"hijack":true}'::jsonb WHERE id = $1`,
        [auditBFirmId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool DELETE on a foreign firm audit row affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM audit_log WHERE id = $1`, [
        auditBFirmId,
      ]);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Pre-auth contract pin — admin pool BYPASSRLS INSERT
  // ---------------------------------------------------------------------------

  it('admin pool can INSERT a NULL firm_id audit row (BYPASSRLS system / customer / failed-auth path)', async () => {
    // System actor (worker), customer self-events, and failed-auth
    // pre-identity emits all write firm_id = NULL through the
    // admin pool. The policy excludes those rows from the firm
    // pool but BYPASSRLS bypasses the WITH CHECK so the writes
    // land. This assertion pins the contract — if a future
    // routing change moves any of these paths to the app pool,
    // their INSERT would fail (firm_id = NULL fails WITH CHECK)
    // and audit gaps would open silently.
    const result = await admin.query<{ id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_label, firm_id, action, meta)
       VALUES ('system', 'pre-auth-contract-pin', NULL, 'system.test',
               '{}'::jsonb)
       RETURNING id`,
    );
    expect(result.rowCount).toBe(1);
    if (result.rows[0] !== undefined) {
      await admin.query('DELETE FROM audit_log WHERE id = $1', [result.rows[0].id]);
    }
  });

  it('admin pool can INSERT an audit row for any firm (BYPASSRLS admin path)', async () => {
    // Admin actions on firm targets (e.g. handleAdminUpdateFirm)
    // write firm_id = target_firm via the writer's resolution
    // chain. Admin handler runs on admin pool (BYPASSRLS); the
    // INSERT lands without app.firm_id ever being set, regardless
    // of which firm it points at.
    const result = await admin.query<{ id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_label, firm_id, action, meta)
       VALUES ('admin_user', gen_random_uuid(), 'admin@example.test', $1,
               'admin.firm.suspended', '{}'::jsonb)
       RETURNING id`,
      [firmBId],
    );
    expect(result.rowCount).toBe(1);
    if (result.rows[0] !== undefined) {
      await admin.query('DELETE FROM audit_log WHERE id = $1', [result.rows[0].id]);
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
        'SELECT id FROM audit_log WHERE id = ANY($1)',
        [[auditAFirmId, auditBFirmId, auditNullFirmId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([auditAFirmId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM audit_log WHERE id = ANY($1)',
        [[auditAFirmId, auditBFirmId, auditNullFirmId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
