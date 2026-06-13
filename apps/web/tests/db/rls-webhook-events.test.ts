// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 11 integration test for the
 * `webhook_events` table.
 *
 * webhook_events is append-only in the codebase: the repository
 * (`createWebhookEvent`) inserts and nothing else writes. The
 * policy is FOR ALL anyway — see migration comment for the
 * rationale (consistency + future-proofing). This suite exercises
 * the production INSERT + SELECT paths as canonical scenarios and
 * UPDATE / DELETE as defense-in-depth assertions that guard
 * against a future "edit event payload" code path landing without
 * RLS scrutiny.
 *
 * Pre-auth contract pin specific to this table: the credential
 * pipeline worker, Didit KYC inbound webhook handler, customer
 * self-revoke, and admin ban cascade all emit through
 * `getDatabaseClient().db` (admin pool, BYPASSRLS) because the
 * firm context is either provider-supplied (Didit), worker-side
 * (no http session), or admin-cross-firm (ban). The post-auth
 * test-webhook trigger from the dashboard runs on `ctx.db = tx`
 * with `app.firm_id` set — that path is also covered.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — webhook_events (Cat 34b Faz 11)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-evt-a`;
  const slugB = `${suffix}-evt-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let eventAId: string;
  let eventBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Event Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Event Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    const ea = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'credential.created', $2)
       RETURNING id`,
      [firmAId, { fixture: 'a' }],
    );
    const eb = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'credential.created', $2)
       RETURNING id`,
      [firmBId, { fixture: 'b' }],
    );
    eventAId = ea.rows[0]!.id;
    eventBId = eb.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query('DELETE FROM webhook_events WHERE id = ANY($1)', [
        [eventAId, eventBId],
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
        'SELECT id FROM webhook_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A events from the app pool when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([eventAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B events from the app pool when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([eventBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture events (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM webhook_events WHERE id = ANY($1) ORDER BY id',
      [[eventAId, eventBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([eventAId, eventBId]));
  });

  // ---------------------------------------------------------------------------
  // INSERT — production path (handleTestWebhook + dashboard test trigger)
  // ---------------------------------------------------------------------------

  it('app pool can INSERT an event for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO webhook_events (firm_id, type, payload)
         VALUES ($1, 'test.webhook', $2)
         RETURNING id`,
        [firmAId, { fixture: 'self-insert' }],
      );
      expect(result.rowCount).toBe(1);
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
          `INSERT INTO webhook_events (firm_id, type, payload)
           VALUES ($1, 'cross.tenant', $2)`,
          [firmBId, { attacker: true }],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool INSERT with no app.firm_id set fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO webhook_events (firm_id, type, payload)
           VALUES ($1, 'unset.check', $2)`,
          [firmAId, { unset: true }],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // UPDATE — defense-in-depth (production code does NOT update events,
  // but the policy permits it under USING / WITH CHECK so a future
  // admin "edit event" tool lands safely)
  // ---------------------------------------------------------------------------

  it('app pool UPDATE on a foreign firm event affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE webhook_events SET payload = '{"hijack":true}'::jsonb WHERE id = $1`,
        [eventBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE that re-homes firm_id fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(`UPDATE webhook_events SET firm_id = $1 WHERE id = $2`, [
          firmBId,
          eventAId,
        ]),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE — defense-in-depth
  // ---------------------------------------------------------------------------

  it('app pool DELETE on a foreign firm event affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM webhook_events WHERE id = $1`, [
        eventBId,
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

  it('admin pool can INSERT an event for any firm (BYPASSRLS worker / webhook / fraud paths)', async () => {
    // Five production paths emit through the admin pool:
    //   - credential-pipeline-worker.ts:529/538/642 (worker)
    //   - didit-webhook.ts:701 (Didit KYC inbound)
    //   - customer-kyc.ts:966 (customer self-revoke)
    //   - fraud/ban.ts:291 (admin ban cascade)
    //   - any future admin operator action
    // None of them carry `app.firm_id` because the firm context is
    // ambient to the worker / provider / cross-firm admin action.
    // BYPASSRLS lets the INSERT land without a SET LOCAL. If a
    // future routing change accidentally moves any of these paths
    // to the app pool, the policy would reject the INSERT (no SET
    // LOCAL → NULLIF → NULL → WITH CHECK fails) and outbound
    // webhook delivery would silently stop firing for the affected
    // event types. This assertion pins the contract.
    const result = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'credential.created', $2)
       RETURNING id`,
      [firmBId, { worker: true, source: 'pre-auth-contract-pin' }],
    );
    expect(result.rowCount).toBe(1);
    // Clean up the row staged inside the assertion so afterAll
    // doesn't have to know about it.
    if (result.rows[0] !== undefined) {
      await admin.query('DELETE FROM webhook_events WHERE id = $1', [result.rows[0].id]);
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
        'SELECT id FROM webhook_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([eventAId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM webhook_events WHERE id = ANY($1)',
        [[eventAId, eventBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
