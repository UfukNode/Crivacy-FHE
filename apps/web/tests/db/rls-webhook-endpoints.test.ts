// @vitest-environment node
/**
 * Cat 34b RLS Refactor — Faz 10 integration test for the
 * `webhook_endpoints` table.
 *
 * Symmetric to `rls-api-keys.test.ts` (Faz 8) and
 * `rls-oauth-clients.test.ts` (Faz 9). One operational difference:
 * webhook_endpoints uses HARD DELETE on revoke (the repository's
 * `deleteEndpoint` actually issues `DELETE FROM webhook_endpoints
 * WHERE id = $1 AND firm_id = $2`), so the policy's USING clause
 * has to permit DELETE explicitly. The api_keys / oauth_clients
 * suites tested DELETE as a defense-in-depth scenario (the
 * production code path is soft-delete UPDATE); this suite tests it
 * as the canonical path.
 *
 * Pre-auth contract pin specific to this table: the webhook
 * delivery worker (`server/jobs/webhook-worker.ts` +
 * `webhook-repository.ts::updateEndpointCircuitBreaker`) runs
 * against the admin pool (BYPASSRLS) — worker job payloads only
 * carry a `deliveryId`, so the firm context is unknown without a
 * join. The circuit-breaker UPDATE without a `firm_id` WHERE keeps
 * working through BYPASSRLS; the test below pins that contract so
 * a future routing change that accidentally routes the worker
 * through the app pool surfaces as a CI failure.
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

describe.skipIf(!RUN_RLS_TESTS)('RLS — webhook_endpoints (Cat 34b Faz 10)', () => {
  const suffix = `rls-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slugA = `${suffix}-wh-a`;
  const slugB = `${suffix}-wh-b`;

  let admin: pg.Pool;
  let app: pg.Pool;
  let firmAId: string;
  let firmBId: string;
  let endpointAId: string;
  let endpointBId: string;

  // The schema requires non-null `signing_secret_ciphertext` +
  // `signing_secret_nonce` (bytea) and `signing_key_version`. Use
  // synthetic placeholder buffers; nothing in this suite verifies
  // signatures, only RLS gating.
  const placeholderCiphertext = Buffer.from('placeholder-ciphertext-bytes-32xx');
  const placeholderNonce = Buffer.from('placeholder-nonce-12-bytes-x');
  const signingKeyVersion = 1;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });

    const a = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Webhook Fixture A (${suffix})`, slugA, `${slugA}@example.test`],
    );
    const b = await admin.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`RLS Webhook Fixture B (${suffix})`, slugB, `${slugB}@example.test`],
    );
    firmAId = a.rows[0]!.id;
    firmBId = b.rows[0]!.id;

    const ea = await admin.query<{ id: string }>(
      `INSERT INTO webhook_endpoints
         (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        firmAId,
        'fixture-a',
        'https://a.example.test/webhook',
        placeholderCiphertext,
        placeholderNonce,
        signingKeyVersion,
      ],
    );
    const eb = await admin.query<{ id: string }>(
      `INSERT INTO webhook_endpoints
         (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        firmBId,
        'fixture-b',
        'https://b.example.test/webhook',
        placeholderCiphertext,
        placeholderNonce,
        signingKeyVersion,
      ],
    );
    endpointAId = ea.rows[0]!.id;
    endpointBId = eb.rows[0]!.id;
  });

  afterAll(async () => {
    if (admin !== undefined) {
      // FK cascades from firms → webhook_endpoints, so dropping
      // fixture firms also drops endpoints. Keep the explicit
      // delete as belt-and-suspenders.
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
  // SELECT visibility
  // ---------------------------------------------------------------------------

  it('returns 0 rows from the app pool when app.firm_id is unset', async () => {
    const client = await app.connect();
    try {
      const { rowCount } = await client.query(
        'SELECT id FROM webhook_endpoints WHERE id = ANY($1)',
        [[endpointAId, endpointBId]],
      );
      expect(rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('returns only firm A endpoints from the app pool when app.firm_id = firmA', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_endpoints WHERE id = ANY($1)',
        [[endpointAId, endpointBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([endpointAId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('returns only firm B endpoints from the app pool when app.firm_id = firmB', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmBId]);
      const result = await client.query<{ id: string }>(
        'SELECT id FROM webhook_endpoints WHERE id = ANY($1)',
        [[endpointAId, endpointBId]],
      );
      expect(result.rows.map((r) => r.id)).toEqual([endpointBId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('admin pool sees both fixture endpoints (BYPASSRLS)', async () => {
    const result = await admin.query<{ id: string; firm_id: string }>(
      'SELECT id, firm_id FROM webhook_endpoints WHERE id = ANY($1) ORDER BY id',
      [[endpointAId, endpointBId]],
    );
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([endpointAId, endpointBId]),
    );
  });

  // ---------------------------------------------------------------------------
  // INSERT — WITH CHECK behaviour
  // ---------------------------------------------------------------------------

  it('app pool can INSERT an endpoint for its own firm', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query<{ id: string }>(
        `INSERT INTO webhook_endpoints
           (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
         VALUES ($1, 'self', 'https://self.example.test/wh', $2, $3, $4)
         RETURNING id`,
        [firmAId, placeholderCiphertext, placeholderNonce, signingKeyVersion],
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
          `INSERT INTO webhook_endpoints
             (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
           VALUES ($1, 'cross-tenant', 'https://attacker.example.test/wh', $2, $3, $4)`,
          [firmBId, placeholderCiphertext, placeholderNonce, signingKeyVersion],
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
          `INSERT INTO webhook_endpoints
             (firm_id, label, url, signing_secret_ciphertext, signing_secret_nonce, signing_key_version)
           VALUES ($1, 'unset', 'https://unset.example.test/wh', $2, $3, $4)`,
          [firmAId, placeholderCiphertext, placeholderNonce, signingKeyVersion],
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

  it('app pool can UPDATE its own endpoint (USING + WITH CHECK match)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE webhook_endpoints SET label = 'self-update-ok' WHERE id = $1`,
        [endpointAId],
      );
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool UPDATE on a foreign firm endpoint affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(
        `UPDATE webhook_endpoints SET label = 'cross-firm-attack' WHERE id = $1`,
        [endpointBId],
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
        client.query(`UPDATE webhook_endpoints SET firm_id = $1 WHERE id = $2`, [
          firmBId,
          endpointAId,
        ]),
      ).rejects.toThrow(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE — production code path uses HARD DELETE here (unlike api_keys
  // / oauth_clients which soft-delete). The policy MUST permit DELETE
  // through USING; both legitimate self-DELETE and the cross-tenant
  // 0-row no-op are tested as canonical scenarios.
  // ---------------------------------------------------------------------------

  it('app pool can DELETE its own endpoint (production hard-delete path)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [
        endpointAId,
      ]);
      expect(result.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('app pool DELETE on a foreign firm endpoint affects 0 rows (USING blocks)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmAId]);
      const result = await client.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [
        endpointBId,
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

  it('admin pool can UPDATE circuit-breaker columns on any firm endpoint (BYPASSRLS worker path)', async () => {
    // `webhook-repository.ts::updateEndpointCircuitBreaker` issues
    // `UPDATE webhook_endpoints SET consecutive_failures = $1,
    // circuit_breaker_tripped_at = $2 WHERE id = $3` (NO firm_id
    // WHERE) from the delivery worker. The worker connects through
    // `getDatabaseClient().db` (admin pool, BYPASSRLS) — it has to,
    // because worker job payloads only carry a `deliveryId` and the
    // firm context isn't available without a join. If a future
    // refactor accidentally routes that UPDATE through the app
    // pool, the policy would block it (no SET LOCAL set yet) and
    // the circuit breaker would silently stop tracking failures,
    // turning the runaway-endpoint defence into a no-op. This
    // assertion pins the contract.
    const result = await admin.query(
      `UPDATE webhook_endpoints
         SET consecutive_failures = 1, last_failure_at = NOW()
       WHERE id = $1`,
      [endpointBId],
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
        'SELECT id FROM webhook_endpoints WHERE id = ANY($1)',
        [[endpointAId, endpointBId]],
      );
      expect(inside.rows.map((r) => r.id)).toEqual([endpointAId]);
      await client.query('COMMIT');

      const after = await client.query(
        'SELECT id FROM webhook_endpoints WHERE id = ANY($1)',
        [[endpointAId, endpointBId]],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
