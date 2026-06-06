/**
 * Retention pruner.
 *
 * Closes AUD-X-COMP-004 + AUD-X-COMP-005. Removes rows whose
 * retention window has elapsed from:
 *
 *   - `audit_log` — per-firm cutoff derived from
 *     `firm_settings.data_retention_days` (default 2555 = 7y).
 *     Rows without a firm id (system actors) use the longest
 *     per-firm window as a fallback ceiling.
 *   - `usage_events` — flat 90-day window. Operational data, no
 *     per-firm config.
 *   - `email_send_log` — flat 2-year window. Covers compliance
 *     requests for "did you send me this email?" while keeping
 *     the table bounded.
 *   - `oauth_authorization_requests` — 30 days. These expire in
 *     15 min anyway but we keep the rows briefly for debugging
 *     rejected flows.
 *
 * Emits `compliance.meta_redacted` once per run summarising the
 * delete counts so the audit trail has a clean record of what
 * the pruner did.
 *
 * Intended to run daily. Uses an advisory lock so concurrent
 * schedulers don't double-run. Safe to invoke manually:
 *
 *   DATABASE_URL=... pnpm tsx scripts/prune-retention.ts
 *
 * @module
 */

import pg from 'pg';

const ADVISORY_LOCK_KEY = 20_260_424_01 as const;

// Flat retention windows (seconds). Per-firm `audit_log` uses a
// dynamic value per row and is handled separately.
const USAGE_EVENTS_RETENTION_DAYS = 90;
const EMAIL_SEND_LOG_RETENTION_DAYS = 730;
const OAUTH_AUTH_REQ_RETENTION_DAYS = 30;

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required.');
  }

  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  const now = new Date();

  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    // --- 1. Per-firm audit_log pruning ---
    // For each firm row, delete audit rows older than
    // `firm.data_retention_days`. Firm-less rows (system actors,
    // pre-firm events) aren't touched by this pass — they're
    // covered by a system-wide ceiling below.
    const firmResult = await client.query<{ data_retention_days: number }>(
      `SELECT MAX(fs.data_retention_days) AS data_retention_days
         FROM firm_settings fs`,
    );
    const maxFirmDays = firmResult.rows[0]?.data_retention_days ?? 2555;

    const auditFirmRes = await client.query(
      `DELETE FROM audit_log
         WHERE firm_id IS NOT NULL
           AND ts < now() - (
             (SELECT COALESCE(fs.data_retention_days, 2555)
                FROM firm_settings fs
               WHERE fs.firm_id = audit_log.firm_id
               LIMIT 1)
             * INTERVAL '1 day'
           )`,
    );

    // Firm-less audit rows (system actors): cap at the longest
    // configured window so no single firm's short retention forces
    // system audit to drop.
    const auditSystemRes = await client.query(
      `DELETE FROM audit_log
         WHERE firm_id IS NULL
           AND ts < now() - ($1::integer * INTERVAL '1 day')`,
      [maxFirmDays],
    );

    // --- 2. Flat retention tables ---
    const usageRes = await client.query(
      `DELETE FROM usage_events
         WHERE ts < now() - ($1::integer * INTERVAL '1 day')`,
      [USAGE_EVENTS_RETENTION_DAYS],
    );

    const emailLogRes = await client.query(
      `DELETE FROM email_send_log
         WHERE created_at < now() - ($1::integer * INTERVAL '1 day')`,
      [EMAIL_SEND_LOG_RETENTION_DAYS],
    );

    const oauthReqRes = await client.query(
      `DELETE FROM oauth_authorization_requests
         WHERE created_at < now() - ($1::integer * INTERVAL '1 day')`,
      [OAUTH_AUTH_REQ_RETENTION_DAYS],
    );

    // --- 3. Summary audit entry ---
    const totals = {
      auditLogFirm: auditFirmRes.rowCount ?? 0,
      auditLogSystem: auditSystemRes.rowCount ?? 0,
      usageEvents: usageRes.rowCount ?? 0,
      emailSendLog: emailLogRes.rowCount ?? 0,
      oauthAuthRequests: oauthReqRes.rowCount ?? 0,
    };

    await client.query(
      `INSERT INTO audit_log
         (actor_kind, actor_id, actor_label, action, meta, ts)
       VALUES
         ('system', NULL, 'retention-pruner', 'compliance.meta_redacted',
          $1::jsonb, $2)`,
      [JSON.stringify({ pruned: totals, runAt: now.toISOString() }), now.toISOString()],
    );

    // eslint-disable-next-line no-console
    console.log('[prune-retention] Done:', totals);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
