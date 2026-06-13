// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 12 integration test for the
 * `webhook_deliveries` table.
 *
 * Sixth firm-scoped table. Unlike Faz 8/9/10/11, the source
 * schema for webhook_deliveries had no `firm_id` column — the
 * row was keyed only by `endpoint_id` and `event_id`. The Faz 12
 * migration denormalized `firm_id` from the endpoint side; this
 * suite exercises the standard RLS contract on the new column
 * plus a contract pin for the denormalization invariant: the
 * delivery's `firm_id` MUST equal the endpoint's `firm_id`,
 * otherwise multi-firm fan-out (`emit.ts::emitUserEvent`) would
 * accidentally lock customers out of their own webhooks.
 *
 * Pre-auth contract pin: the delivery worker
 * (`server/jobs/webhook-worker.ts` +
 * `webhook-repository.ts::markDelivered/markFailed/markDeadLettered`)
 * runs against the admin pool because the worker job payload
 * carries only a `deliveryId`. Those status UPDATEs without a
 * `firm_id` WHERE keep working through BYPASSRLS — same pattern
 * as Faz 10's `updateEndpointCircuitBreaker` pin.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — webhook_deliveries (Cat 34b Faz 12)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-del-a`;
  const slugB = `${suffix}-del-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let endpointAId: string;
  let endpointBId: string;
  let eventAId: string;
  let eventBId: string;
  let deliveryAId: string;
  let deliveryBId: string;

  const placeholderCiphertext = Buffer.from('placeholder-ciphertext-bytes-32xx');
  const placeholderNonce = Buffer.from('placeholder-nonce-12-bytes-x');

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Delivery Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS Delivery Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    const ea = await admin.query<{ id: string }>(
      `INSERT INTO webhook_endpoints
         (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
       VALUES ($1, 'fixture-a', 'https://a.example.test/wh', $2, $3, 1)
       RETURNING id`,
      [firmAId, placeholderCiphertext, placeholderNonce],
    );
    const eb = await admin.query<{ id: string }>(
      `INSERT INTO webhook_endpoints
         (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
       VALUES ($1, 'fixture-b', 'https://b.example.test/wh', $2, $3, 1)
       RETURNING id`,
      [firmBId, placeholderCiphertext, placeholderNonce],
    );
    endpointAId = ea.rows[0]!.id;
    endpointBId = eb.rows[0]!.id;

    const evA = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'credential.created', $2) RETURNING id`,
      [firmAId, { fixture: 'a' }],
    );
    const evB = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'credential.created', $2) RETURNING id`,
      [firmBId, { fixture: 'b' }],
    );
    eventAId = evA.rows[0]!.id;
    eventBId = evB.rows[0]!.id;

    const dA = await admin.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, firm_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [endpointAId, eventAId, firmAId],
    );
    const dB = await admin.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, firm_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [endpointBId, eventBId, firmBId],
    );
    deliveryAId = dA.rows[0]!.id;
    deliveryBId = dB.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      // FK cascade from firms drops everything; explicit deletes
      // are belt-and-suspenders for partial fixture failures.
      await admin.query('DELETE FROM webhook_deliveries WHERE id = ANY($1)', [
        [deliveryAId, deliveryBId],
      ]);
      await admin.query('DELETE FROM webhook_events WHERE id = ANY($1)', [
        [eventAId, eventBId],
      ]);
      await admin.query('DELETE FROM webhook_endpoints WHERE id = ANY($1)', [
        [endpointAId, endpointBId],
      ]);
      await admin.query('DELETE FROM firms WHERE id = ANY($1)', [[firmAId, firmBId]]);
      await admin.end();
    }
    if (app !== undefined) {
      await app.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Schema invariant — denormalized firm_id matches endpoint
  // ---------------------------------------------------------------------------

  it('denormalized firm_id equals webhook_endpoints.firm_id (backfill invariant)', async () => {
    // The Faz 12 migration's backfill set delivery.firm_id from
    // the endpoint. If a future change breaks that invariant
    // (e.g., a new INSERT path forgets to copy the firm), every
    // RLS gate downstream is misaligned. This assertion locks the
    // contract for both fixture rows.
    const result = await admin.query<{
      delivery_firm: string;
      endpoint_firm: string;
    }>(
      `SELECT d.firm_id AS delivery_firm, e.firm_id AS endpoint_firm
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.id = ANY($1)`,
      [[deliveryAId, deliveryBId]],
    );
    expect(result.rowCount).toBe(2);
    for (const row of result.rows) {
      expect(row.delivery_firm).toBe(row.endpoint_firm);
    }
  });

  // ---------------------------------------------------------------------------
  // SELECT visibility
  // ---------------------------------------------------------------------------

  it('returns 0 rows from the app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM webhook_deliveries WHERE id = ANY($1)',
        [[deliveryAId, deliveryBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A deliveries when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_deliveries WHERE id = ANY($1)',
        [[deliveryAId, deliveryBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([deliveryAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B deliveries when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_deliveries WHERE id = ANY($1)',
        [[deliveryAId, deliveryBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([deliveryBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture deliveries (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string }>(
      'SELECT id FROM webhook_deliveries WHERE id = ANY($1) ORDER BY id',
      [[deliveryAId, deliveryBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([deliveryAId, deliveryBId]),
    );
  });

  // ---------------------------------------------------------------------------
  // INSERT — production path (emit.ts + handleTestWebhook)
  // ---------------------------------------------------------------------------

  it('app pool can INSERT a delivery for its own firm', async () => {
    // Stage a fresh event so the (endpoint_id, event_id) unique
    // index doesn't collide with the fixture delivery. Admin pool
    // bypasses RLS for test setup.
    const freshEvent = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'test.insert', '{}'::jsonb) RETURNING id`,
      [firmAId],
    );
    const freshEventId = freshEvent.rows[0]!.id;

    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO webhook_deliveries (endpoint_id, event_id, firm_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [endpointAId, freshEventId, firmAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already rolled back / no tx open — ignore
      }
      client.release();
    }
    // Drop the staged event since the tx that referenced it rolled
    // back; the event itself stays committed because admin pool
    // wrote it outside any tx.
    await admin.query('DELETE FROM webhook_events WHERE id = $1', [freshEventId]);
  });

  it('app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    // Use a fresh (endpoint_b, event_b) pair via a new event so
    // the unique index doesn't collide before the policy runs.
    const freshEvent = await admin.query<{ id: string }>(
      `INSERT INTO webhook_events (firm_id, type, payload)
       VALUES ($1, 'test.cross-tenant', '{}'::jsonb) RETURNING id`,
      [firmBId],
    );
    const freshEventId = freshEvent.rows[0]!.id;

    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO webhook_deliveries (endpoint_id, event_id, firm_id)
           VALUES ($1, $2, $3)`,
          [endpointBId, freshEventId, firmBId],
        ),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // already rolled back / no tx open — ignore
      }
      client.release();
    }
    await admin.query('DELETE FROM webhook_events WHERE id = $1', [freshEventId]);
  });

  // ---------------------------------------------------------------------------
  // UPDATE — production code (worker markDelivered/markFailed/etc.)
  // runs on admin pool, but the policy must still gate handler-side
  // updates correctly.
  // ---------------------------------------------------------------------------

  it('app pool can UPDATE its own delivery (USING + WITH CHECK match)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE webhook_deliveries SET response_body_sample = 'self-update-ok' WHERE id = $1`,
        [deliveryAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm delivery affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE webhook_deliveries SET response_body_sample = 'cross-firm-attack' WHERE id = $1`,
        [deliveryBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE — defense-in-depth (production hard-deletes only via firms
  // cascade)
  // ---------------------------------------------------------------------------

  it('app pool DELETE on a foreign firm delivery affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM webhook_deliveries WHERE id = $1`, [
        deliveryBId,
      ]);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Pre-auth contract pin — admin pool BYPASSRLS UPDATE
  // ---------------------------------------------------------------------------

  it('admin pool can UPDATE delivery status on any firm row (BYPASSRLS worker path)', async () => {
    // `webhook-repository.ts::markDelivered/markFailed/markDeadLettered`
    // issue UPDATE without firm_id WHERE from the delivery worker.
    // The worker connects through getDatabaseClient().db (admin
    // pool, BYPASSRLS) — worker job payloads only carry a
    // deliveryId, so the firm context is unknown without a join.
    // If a future routing change accidentally moves the worker
    // through the app pool, the policy would block these UPDATEs
    // (no SET LOCAL set yet) and webhook delivery state tracking
    // would silently break. This test pins the contract.
    const result = await admin.query(
      `UPDATE webhook_deliveries
         SET status = 'delivered', delivered_at = NOW(), attempts = 1, last_attempt_at = NOW()
       WHERE id = $1`,
      [deliveryBId],
    );
    expect(result.rowCount).toBe(1);
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
        'SELECT id FROM webhook_deliveries WHERE id = ANY($1)',
        [[deliveryAId, deliveryBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([deliveryAId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM webhook_deliveries WHERE id = ANY($1)',
        [[deliveryAId, deliveryBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
