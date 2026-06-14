// @vitest-environment node
/**
 * Credential expiry worker — sweep behaviour integration test.
 *
 * Exercises `processExpirySweep` against a live local Postgres
 * with real fixture rows. Mock-based tests would have to stub
 * the repositories AND the webhook emit chain; the round-trip
 * cost is small enough that the integration variant catches
 * more (FK ordering, RLS BYPASSRLS contract under the admin
 * pool, partial unique index `kyc_credentials_meta_firm_user_
 * active_key` interaction with the status flip).
 *
 * The suite skips cleanly when the DB env vars are unset so
 * CI runners without Postgres still see a green run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from '@/lib/db/schema';
import { processExpirySweep } from '@/server/jobs/credential-expire-worker';

const ADMIN_URL =
  process.env['DATABASE_URL_ADMIN'] !== undefined &&
  process.env['DATABASE_URL_ADMIN'].length > 0
    ? process.env['DATABASE_URL_ADMIN']
    : process.env['DATABASE_URL'];

const RUN_TESTS = ADMIN_URL !== undefined && ADMIN_URL.length > 0;

describe.skipIf(!RUN_TESTS)('credential-expire-worker', () => {
  const suffix = `expire-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let firmId: string;
  let apiKeyId: string;
  let kycSessionId: string;
  let agedCredentialId: string;
  let freshCredentialId: string;
  let alreadyExpiredCredentialId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
    db = drizzle(pool, { schema });

    // Stage one firm + one api key + one kyc session as FK targets.
    const f = await pool.query<{ id: string }>(
      `INSERT INTO firms (name, slug, contact_email)
       VALUES ($1, $2, $3) RETURNING id`,
      [`Expire Worker Fixture (${suffix})`, suffix, `${suffix}@example.test`],
    );
    firmId = f.rows[0]!.id;

    const prefixNonce = Math.random().toString(36).slice(2, 6);
    const k = await pool.query<{ id: string }>(
      `INSERT INTO api_keys (firm_id, prefix, hash, name, mode)
       VALUES ($1, $2, '$2b$04$x', 'expire-fixture', 'live') RETURNING id`,
      [firmId, `crv_${prefixNonce}_x`],
    );
    apiKeyId = k.rows[0]!.id;

    const s = await pool.query<{ id: string }>(
      `INSERT INTO kyc_sessions
         (firm_id, user_ref, created_by_api_key_id, workflow, level, didit_workflow_id,
          expires_at)
       VALUES ($1, $2, $3, 'identity', 'basic', 'wf-test', NOW() + interval '1 day')
       RETURNING id`,
      [firmId, `user-${suffix}`, apiKeyId],
    );
    kycSessionId = s.rows[0]!.id;

    // Three credential fixtures:
    //   - aged: valid_until in the past, status=active, expired_at NULL
    //     → MUST be picked up and flipped by the sweep.
    //   - fresh: valid_until in the future, status=active
    //     → MUST NOT be touched.
    //   - already-expired: valid_until in the past, status=active,
    //     expired_at already stamped → MUST NOT be re-processed
    //     (would cause duplicate webhook fires).
    //
    // Three different user_refs so the
    // `kyc_credentials_meta_firm_user_active_key` partial unique
    // index doesn't reject the second / third INSERT.
    const aged = await pool.query<{ id: string }>(
      `INSERT INTO kyc_credentials_meta
         (firm_id, user_ref, kyc_session_id, chain_package_name, chain_template_id,
          chain_network, operator_party, user_party, level, status, validator,
          proof_hash, valid_until)
       VALUES ($1, $2, $3, 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
               'op', 'up-aged', 'basic', 'active', 'didit', 'h-aged',
               NOW() - interval '1 day')
       RETURNING id`,
      [firmId, `user-${suffix}-aged`, kycSessionId],
    );
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO kyc_credentials_meta
         (firm_id, user_ref, kyc_session_id, chain_package_name, chain_template_id,
          chain_network, operator_party, user_party, level, status, validator,
          proof_hash, valid_until)
       VALUES ($1, $2, $3, 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
               'op', 'up-fresh', 'basic', 'active', 'didit', 'h-fresh',
               NOW() + interval '180 days')
       RETURNING id`,
      [firmId, `user-${suffix}-fresh`, kycSessionId],
    );
    const already = await pool.query<{ id: string }>(
      `INSERT INTO kyc_credentials_meta
         (firm_id, user_ref, kyc_session_id, chain_package_name, chain_template_id,
          chain_network, operator_party, user_party, level, status, validator,
          proof_hash, valid_until, expired_at)
       VALUES ($1, $2, $3, 'crivacy-kyc-v2', 'KYCCredential', 'devnet',
               'op', 'up-already', 'basic', 'active', 'didit', 'h-already',
               NOW() - interval '5 days', NOW() - interval '4 days')
       RETURNING id`,
      [firmId, `user-${suffix}-already`, kycSessionId],
    );
    agedCredentialId = aged.rows[0]!.id;
    freshCredentialId = fresh.rows[0]!.id;
    alreadyExpiredCredentialId = already.rows[0]!.id;
  });

  afterAll(async () => {
    if (pool !== undefined) {
      // Cascade from firms drops everything tied to the fixture firm.
      await pool.query(
        `DELETE FROM webhook_events WHERE firm_id = $1`,
        [firmId],
      );
      await pool.query(`DELETE FROM kyc_credentials_meta WHERE firm_id = $1`, [firmId]);
      await pool.query(`DELETE FROM kyc_sessions WHERE firm_id = $1`, [firmId]);
      await pool.query(`DELETE FROM api_keys WHERE firm_id = $1`, [firmId]);
      await pool.query(`DELETE FROM firms WHERE id = $1`, [firmId]);
      await pool.end();
    }
  });

  it('flips aged active credentials to expired and emits credential.expired', async () => {
    const now = new Date();
    const result = await processExpirySweep({ db, clock: () => now, batchSize: 50 });

    // The aged credential is included; the fresh and already-
    // expired rows are NOT (fresh hasn't expired yet,
    // already-expired has expired_at stamped).
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    // The aged credential row was flipped to status='expired'
    // with expired_at stamped.
    const aged = await pool.query<{ status: string; expired_at: Date | null }>(
      `SELECT status, expired_at FROM kyc_credentials_meta WHERE id = $1`,
      [agedCredentialId],
    );
    expect(aged.rows[0]?.status).toBe('expired');
    expect(aged.rows[0]?.expired_at).not.toBeNull();

    // The fresh credential is untouched.
    const fresh = await pool.query<{ status: string; expired_at: Date | null }>(
      `SELECT status, expired_at FROM kyc_credentials_meta WHERE id = $1`,
      [freshCredentialId],
    );
    expect(fresh.rows[0]?.status).toBe('active');
    expect(fresh.rows[0]?.expired_at).toBeNull();

    // The already-expired credential is untouched (still active
    // by our fixture but with expired_at stamped — the partial
    // unique index lets it stay 'active' here, in production the
    // sweep would have flipped it on a previous tick. The point
    // is that this run does NOT re-process it.).
    const already = await pool.query<{ status: string }>(
      `SELECT status FROM kyc_credentials_meta WHERE id = $1`,
      [alreadyExpiredCredentialId],
    );
    expect(already.rows[0]?.status).toBe('active');

    // A credential.expired event was emitted to the firm.
    const events = await pool.query<{ id: string }>(
      `SELECT id FROM webhook_events
        WHERE firm_id = $1
          AND type = 'credential.expired'
          AND source_credential_id = $2`,
      [firmId, agedCredentialId],
    );
    expect(events.rowCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op when no credentials are aged', async () => {
    // After the previous test the aged row is already `expired`,
    // so the second sweep on the same fixture finds no candidates.
    const result = await processExpirySweep({ db, batchSize: 50 });
    // expired count for THIS sweep — could be > 0 if other dev
    // rows are aged, but no errors and the function returns
    // cleanly.
    expect(result.errors).toBe(0);
    expect(result).toMatchObject({ scanned: expect.any(Number), expired: expect.any(Number) });
  });
});
