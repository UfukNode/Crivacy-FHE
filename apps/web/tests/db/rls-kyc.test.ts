// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 14 integration test for the KYC
 * tables (`kyc_sessions` and `kyc_credentials_meta`).
 *
 * The plan (§5) anticipated three tables (`kyc_credentials_meta` +
 * `kyc_credential_checks`); the second one does not exist in the
 * actual schema. The KYC step lifecycle lives in the
 * `kyc_sessions.status` enum + Didit's decision payload column,
 * so the suite covers `kyc_sessions` (the lifecycle tracker the
 * plan missed) and `kyc_credentials_meta` (the on-chain mirror)
 * with a single shared fixture set.
 *
 * Pre-auth contract pins specific to KYC:
 *   - Didit webhook + credential pipeline worker write through
 *     the admin pool (BYPASSRLS) — covered with INSERT/UPDATE
 *     pins for both tables.
 *   - Customer-portal KYC routes also run on the admin pool
 *     (customerRoute is not firm-scoped at the DB layer).
 *   - Post-auth `/api/v1/sessions` and `/api/v1/credentials` run
 *     on `ctx.db = tx`, so app-pool INSERT WITH CHECK on the
 *     caller's firm covers that surface.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — KYC tables (Cat 34b Faz 14)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-kyc-a`;
  const slugB = `${suffix}-kyc-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let apiKeyAId: string;
  let apiKeyBId: string;
  let sessionAId: string;
  let sessionBId: string;
  let customerSessionId: string;
  let customerForCustomerSessionId: string;
  let credAId: string;
  let credBId: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS KYC Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`RLS KYC Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    // kyc_sessions.created_by_api_key_id is NOT NULL with ON DELETE
    // RESTRICT — stage one api_key per fixture firm so the session
    // INSERT below has a valid FK target.
    // api_keys.prefix is varchar(12) — keep the synthetic value
    // under 12 chars (4-char nonce derived from the suffix).
    const prefixNonce = Math.random().toString(36).slice(2, 6);
    const kA = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, '$2b$04$x', 'kyc-fixture-a', 'live') RETURNING id`,
      [firmAId, `crv_${prefixNonce}_a`],
    );
    const kB = await admin.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, '$2b$04$x', 'kyc-fixture-b', 'live') RETURNING id`,
      [firmBId, `crv_${prefixNonce}_b`],
    );
    apiKeyAId = kA.rows[0]!.id;
    apiKeyBId = kB.rows[0]!.id;

    // kyc_sessions fixtures.
    // Sprint 7 Phase A — every kyc_sessions INSERT must set `kind`.
    // The B2B fixtures use `kind = 'b2b'`; a third row with
    // `kind = 'customer'` is staged below to exercise the Sprint 7
    // RLS invariant (customer rows invisible to firm pool).
    const sA = await admin.query<{ id: string }>(
      `INSERT INTO kyc_sessions
         (kind, firm_id, user_ref, created_by_api_key_id, workflow, level, didit_workflow_id,
          expires_at)
       VALUES ('b2b', $1, 'user-a', $2, 'identity', 'basic', 'wf-test', NOW() + interval '1 day')
       RETURNING id`,
      [firmAId, apiKeyAId],
    );
    const sB = await admin.query<{ id: string }>(
      `INSERT INTO kyc_sessions
         (kind, firm_id, user_ref, created_by_api_key_id, workflow, level, didit_workflow_id,
          expires_at)
       VALUES ('b2b', $1, 'user-b', $2, 'identity', 'basic', 'wf-test', NOW() + interval '1 day')
       RETURNING id`,
      [firmBId, apiKeyBId],
    );
    sessionAId = sA.rows[0]!.id;
    sessionBId = sB.rows[0]!.id;

    // Sprint 7 Phase L — stage one `kind = 'customer'` row so the
    // Sprint 7 RLS invariant ("firm pool sees only `kind = 'b2b'`
    // rows whose firm_id matches the session var") can be pinned by
    // a positive negative-arm probe rather than a single-arm one.
    const customerRow = await admin.query<{ id: string }>(
      `INSERT INTO customers (display_name, email)
       VALUES ('rls-kyc-customer', $1)
       RETURNING id`,
      [`rls-kyc-customer-${suffix}@example.test`],
    );
    customerForCustomerSessionId = customerRow.rows[0]!.id;
    const sCustomer = await admin.query<{ id: string }>(
      `INSERT INTO kyc_sessions
         (kind, customer_id, workflow, didit_workflow_id, expires_at)
       VALUES ('customer', $1, 'identity', 'wf-test', NOW() + interval '1 day')
       RETURNING id`,
      [customerForCustomerSessionId],
    );
    customerSessionId = sCustomer.rows[0]!.id;

    // kyc_credentials_meta fixtures.
    const cA = await admin.query<{ id: string }>(
      `INSERT INTO kyc_credentials_meta
         (firm_id, user_ref, kyc_session_id, chain_package_name, chain_template_id,
          chain_network, operator_party, user_party, level, validator, proof_hash,
          valid_until)
       VALUES ($1, 'user-a', $2, 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
               'op-fixture', 'user-a-party', 'basic', 'didit', 'hash-a',
               NOW() + interval '1 year')
       RETURNING id`,
      [firmAId, sessionAId],
    );
    const cB = await admin.query<{ id: string }>(
      `INSERT INTO kyc_credentials_meta
         (firm_id, user_ref, kyc_session_id, chain_package_name, chain_template_id,
          chain_network, operator_party, user_party, level, validator, proof_hash,
          valid_until)
       VALUES ($1, 'user-b', $2, 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
               'op-fixture', 'user-b-party', 'basic', 'didit', 'hash-b',
               NOW() + interval '1 year')
       RETURNING id`,
      [firmBId, sessionBId],
    );
    credAId = cA.rows[0]!.id;
    credBId = cB.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query('DELETE FROM kyc_credentials_meta WHERE id = ANY($1)', [
        [credAId, credBId],
      ]);
      await admin.query('DELETE FROM kyc_sessions WHERE id = ANY($1)', [
        [sessionAId, sessionBId, customerSessionId],
      ]);
      if (customerForCustomerSessionId !== undefined) {
        await admin.query('DELETE FROM customers WHERE id = $1', [
          customerForCustomerSessionId,
        ]);
      }
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
  // kyc_sessions — SELECT visibility
  // ---------------------------------------------------------------------------

  it('kyc_sessions: returns 0 rows from app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM kyc_sessions WHERE id = ANY($1)',
        [[sessionAId, sessionBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('kyc_sessions: returns only firm A sessions when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM kyc_sessions WHERE id = ANY($1)',
        [[sessionAId, sessionBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([sessionAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('kyc_sessions: admin pool sees both fixture sessions (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string }>(
      'SELECT id FROM kyc_sessions WHERE id = ANY($1) ORDER BY id',
      [[sessionAId, sessionBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([sessionAId, sessionBId]),
    );
  });

  // ---------------------------------------------------------------------------
  // Sprint 7 — kind-aware RLS invariant
  // ---------------------------------------------------------------------------

  it('kyc_sessions: customer-kind rows are invisible to the firm pool (Sprint 7)', async () => {
    // The Phase A RLS policy `kyc_sessions_firm_scoped` pins
    // `kind = 'b2b' AND firm_id = current_setting('app.firm_id')`.
    // A customer-kind row should be invisible to ANY firm pool
    // session, regardless of the `app.firm_id` setting, because
    // customer rows route through the admin pool (BYPASSRLS) at the
    // customer-portal handler layer (`server/middleware/customer-route.ts`).
    const client = await app.connect();
    try {
      // No app.firm_id → 0 rows expected (the pre-auth invariant).
      const noScope = await client.query(
        'SELECT id FROM kyc_sessions WHERE id = $1',
        [customerSessionId],
      );
      expect(noScope.rowCount).toBe(0);

      // app.firm_id = firmA → still 0 rows: the firm pool cannot see
      // customer-kind rows even by elevating its session to a firm
      // scope.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const withScope = await client.query(
        'SELECT id FROM kyc_sessions WHERE id = $1',
        [customerSessionId],
      );
      expect(withScope.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('kyc_sessions: admin pool reads customer-kind rows (BYPASSRLS) — Sprint 7', async () => {
    // The bypass is what makes the customer-portal handler reads
    // work. Pin the contract so future RLS tightening that
    // accidentally clipped the bypass would surface here.
    const result = await admin.query<{ id: string; kind: string }>(
      'SELECT id, kind FROM kyc_sessions WHERE id = $1',
      [customerSessionId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.kind).toBe('customer');
  });

  // ---------------------------------------------------------------------------
  // kyc_sessions — INSERT WITH CHECK
  // ---------------------------------------------------------------------------

  it('kyc_sessions: app pool can INSERT a session for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO kyc_sessions
           (firm_id, user_ref, created_by_api_key_id, workflow, level,
            didit_workflow_id, expires_at)
         VALUES ($1, 'self-insert', $2, 'identity', 'basic', 'wf-test',
                 NOW() + interval '1 day')
         RETURNING id`,
        [firmAId, apiKeyAId],
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

  it('kyc_sessions: app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO kyc_sessions
             (firm_id, user_ref, created_by_api_key_id, workflow, level,
              didit_workflow_id, expires_at)
           VALUES ($1, 'cross-tenant', $2, 'identity', 'basic', 'wf-test',
                   NOW() + interval '1 day')`,
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

  // ---------------------------------------------------------------------------
  // kyc_sessions — UPDATE behaviour
  // ---------------------------------------------------------------------------

  it('kyc_sessions: app pool UPDATE on a foreign firm session affects 0 rows', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE kyc_sessions SET status = 'rejected' WHERE id = $1`,
        [sessionBId],
      );
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // kyc_sessions — admin BYPASSRLS pre-auth pin (Didit webhook updates)
  // ---------------------------------------------------------------------------

  it('kyc_sessions: admin pool can UPDATE status on any firm row (BYPASSRLS Didit webhook path)', async () => {
    // didit-webhook.ts and credential-pipeline-worker.ts both
    // update kyc_sessions.status without firm_id WHERE through
    // the admin pool. If a routing change moves them to the app
    // pool, the policy would block the UPDATE (no SET LOCAL set
    // yet) and KYC lifecycle progression would silently break.
    const result = await admin.query(
      `UPDATE kyc_sessions SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [sessionBId],
    );
    expect(result.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // kyc_credentials_meta — SELECT visibility
  // ---------------------------------------------------------------------------

  it('kyc_credentials_meta: returns 0 rows from app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM kyc_credentials_meta WHERE id = ANY($1)',
        [[credAId, credBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('kyc_credentials_meta: returns only firm A credentials when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM kyc_credentials_meta WHERE id = ANY($1)',
        [[credAId, credBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([credAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('kyc_credentials_meta: admin pool sees both fixture credentials (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string }>(
      'SELECT id FROM kyc_credentials_meta WHERE id = ANY($1) ORDER BY id',
      [[credAId, credBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(new Set([credAId, credBId]));
  });

  // ---------------------------------------------------------------------------
  // kyc_credentials_meta — INSERT WITH CHECK
  // ---------------------------------------------------------------------------

  it('kyc_credentials_meta: app pool INSERT for a foreign firm fails the WITH CHECK clause', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      await expect(
        client.query(
          `INSERT INTO kyc_credentials_meta
             (firm_id, user_ref, chain_package_name, chain_template_id,
              chain_network, operator_party, user_party, level, validator,
              proof_hash, valid_until)
           VALUES ($1, 'cross-tenant', 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
                   'op', 'up', 'basic', 'didit', 'hash', NOW() + interval '1 year')`,
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

  // ---------------------------------------------------------------------------
  // kyc_credentials_meta — admin BYPASSRLS pin (credential-pipeline-worker)
  // ---------------------------------------------------------------------------

  it('kyc_credentials_meta: admin pool can UPDATE status on any firm row (BYPASSRLS pipeline worker path)', async () => {
    // credential-pipeline-worker.ts flips status from `pending`
    // to `active` after Chain submit-and-wait returns. The
    // worker has no http session so it cannot set app.firm_id;
    // the admin pool BYPASSRLS lets the UPDATE land. Routing
    // change to app pool would silently freeze the pipeline.
    const result = await admin.query(
      `UPDATE kyc_credentials_meta
         SET status = 'active', confirmed_at = NOW(), chain_contract_id = 'fixture-cid'
       WHERE id = $1`,
      [credBId],
    );
    expect(result.rowCount).toBe(1);
    // Reset for downstream tests / fixtures.
    await admin.query(
      `UPDATE kyc_credentials_meta
         SET status = 'pending', confirmed_at = NULL, chain_contract_id = NULL
       WHERE id = $1`,
      [credBId],
    );
  });

  // ---------------------------------------------------------------------------
  // Transaction scope hygiene (one assertion covering both tables)
  // ---------------------------------------------------------------------------

  it('SET LOCAL does not leak across transactions on a pooled connection', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const insideSessions = await client.query<{ id: string }>(
        'SELECT id FROM kyc_sessions WHERE id = ANY($1)',
        [[sessionAId, sessionBId]],
      );
      expect(insideSessions.rows.map((r) => r.id)).toEqual([sessionAId]);
      const insideCreds = await client.query<{ id: string }>(
        'SELECT id FROM kyc_credentials_meta WHERE id = ANY($1)',
        [[credAId, credBId]],
      );
      expect(insideCreds.rows.map((r) => r.id)).toEqual([credAId]);
      await client.query('COMMIT');

      const afterSessions = await client.query(
        'SELECT id FROM kyc_sessions WHERE id = ANY($1)',
        [[sessionAId, sessionBId]],
      );
      expect(afterSessions.rowCount).toBe(0);
      const afterCreds = await client.query(
        'SELECT id FROM kyc_credentials_meta WHERE id = ANY($1)',
        [[credAId, credBId]],
      );
      expect(afterCreds.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
