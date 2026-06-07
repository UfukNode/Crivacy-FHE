/**
 * One-off dev-environment script: archive every on-chain mint / NFT /
 * credential record, then wipe the customer-facing KYC artefacts so
 * every customer looks like a brand-new account that has never run
 * a verification flow.
 *
 * What it touches (per customer, all customers in the DB):
 *
 *   ARCHIVED to a JSON file (audit-friendly, restorable):
 *     * `kyc_credentials_meta` rows — chain contract IDs, NFT contract
 *       IDs, proof hashes, mint timestamps, revoke reasons. The
 *       disclosure_blob_cache bytea is dropped from the archive (it can
 *       be regenerated from chain) but its size is recorded.
 *     * `kyc_sessions` rows — Didit session IDs, statuses, completion
 *       timestamps, failure reasons.
 *     * `kyc_device_handoffs` rows — outstanding handoff tokens.
 *
 *   DELETED after archive:
 *     * Same three tables above (rows go away after archive).
 *     * `audit_log` rows whose action matches the customer-KYC family
 *       (`customer.kyc_*`, `kyc_session.*`, `kyc_reconciler.*`,
 *       `fraud.*`, `customer.fraud_detected`,
 *       `customer.kyc_revoked_by_didit_user`,
 *       `kyc.b2b_credential_issued`).
 *     * `notifications` rows whose type starts with `kyc.`.
 *     * `ip_abuse_signals` rows — anti-evader fingerprints. Wipe so a
 *       fresh test sweep doesn't trip the gate.
 *
 *   UPDATED (NOT deleted — accounts stay):
 *     * `customers.kyc_level` → `kyc_0`
 *     * `customers.kyc_score` → 0
 *     * `customers.kyc_fields_locked` → false
 *     * `customers.revoked_at` → NULL
 *     * `customers.revoked_reason` → NULL
 *     * `customers.updated_at` → now()
 *
 * Out of scope (not touched):
 *   * `customers` row identity (id, email, password_hash, display_name,
 *     terms_accepted_at, email_verified_at) — stays intact so the user
 *     can log in immediately.
 *   * `customer_sessions` (auth sessions) — orthogonal to KYC.
 *   * `webhook_endpoints`, `oauth_clients`, `firms` — firm-side data.
 *   * chain — this script does NOT call `archive` on any
 *     contract. Existing on-chain credentials stay where they are; the
 *     archive JSON is the only way to find them after this script runs.
 *     If you want to also archive on-chain, run `one-off-chain-revoke.ts`
 *     first using the IDs from the archive JSON.
 *
 * Safety:
 *   * `--dry-run` — print counts, write the archive, do NOT mutate.
 *   * `--confirm` — required to actually run the destructive part.
 *     Without it, the script aborts after dry-run output.
 *   * Wrapped in a single transaction — either everything lands or
 *     nothing does.
 *
 * Usage:
 *   pnpm --filter @crivacy/web exec tsx scripts/reset-all-kyc-fresh-start.ts --dry-run
 *   pnpm --filter @crivacy/web exec tsx scripts/reset-all-kyc-fresh-start.ts --confirm
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

function loadEnv(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

interface CredentialArchive {
  readonly id: string;
  readonly firmId: string;
  readonly userRef: string;
  readonly kycSessionId: string | null;
  readonly chainContractId: string | null;
  readonly chainNetwork: string;
  readonly operatorParty: string;
  readonly userParty: string;
  readonly level: string;
  readonly status: string;
  readonly proofHash: string;
  readonly humanScore: number;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly expiredAt: string | null;
  readonly nftContractId: string | null;
  readonly nftMintedAt: string | null;
  readonly nftBurnedAt: string | null;
  readonly disclosureBlobBytes: number;
  readonly chainSubmissionId: string | null;
  readonly createdAt: string;
}

interface SessionArchive {
  readonly id: string;
  readonly kind: string;
  readonly customerId: string | null;
  readonly firmId: string | null;
  readonly userRef: string | null;
  readonly workflow: string;
  readonly status: string;
  readonly diditSessionId: string | null;
  readonly failureReason: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

interface HandoffArchive {
  readonly id: string;
  readonly customerId: string;
  readonly sessionId: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

interface ArchiveBundle {
  readonly generatedAt: string;
  readonly databaseUrl: string;
  readonly counts: {
    readonly customers: number;
    readonly credentials: number;
    readonly sessions: number;
    readonly handoffs: number;
    readonly auditRows: number;
    readonly notifications: number;
    readonly ipAbuseRows: number;
  };
  readonly credentials: readonly CredentialArchive[];
  readonly sessions: readonly SessionArchive[];
  readonly handoffs: readonly HandoffArchive[];
}

// Exact-list of audit actions that don't share a clean LIKE prefix
// with the rest of the customer-KYC family. Combined below with three
// LIKE patterns (`customer.kyc_%`, `kyc_session.%`, `kyc_reconciler.%`,
// `fraud.%`) so any future `customer.kyc_<verb>` audit action lands in
// the wipe automatically without a script edit.
const KYC_AUDIT_ACTION_EXACT = [
  'customer.fraud_detected',
  'kyc.b2b_credential_issued',
];

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv(resolve(here, '../.env'));
  loadEnv(resolve(here, '../.env.local'));

  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.argv.includes('--confirm');

  if (!dryRun && !confirmed) {
    console.error(
      'Refusing to run without an explicit flag.\n' +
        'Use --dry-run to preview, or --confirm to execute the wipe.',
    );
    process.exit(2);
  }
  if (dryRun && confirmed) {
    console.error('Cannot pass both --dry-run and --confirm.');
    process.exit(2);
  }

  const databaseUrl =
    process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('DATABASE_URL_ADMIN or DATABASE_URL must be set.');
    process.exit(1);
  }

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const db = drizzle(pool);

  // Refuse to run against any host that doesn't look like a local dev
  // database. Production reset would require a real archive workflow
  // (chain revoke first, then per-firm GDPR notification, then DB
  // wipe) — this script is dev-only.
  const lower = databaseUrl.toLowerCase();
  const isLocal =
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('@postgres') ||
    lower.includes('@crivacy-postgres');
  if (!isLocal) {
    console.error(
      'Refusing to run against a non-local DATABASE_URL.\n' +
        'This script is dev-only — do NOT run it against production.',
    );
    process.exit(2);
  }

  try {
    /* ---------- Snapshot counts BEFORE the wipe ---------- */

    const customerCount = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM customers WHERE deleted_at IS NULL`,
    );
    const credentialRows = await db.execute<{
      id: string;
      firm_id: string;
      user_ref: string;
      kyc_session_id: string | null;
      chain_contract_id: string | null;
      chain_network: string;
      operator_party: string;
      user_party: string;
      level: string;
      status: string;
      proof_hash: string;
      human_score: number;
      valid_from: string;
      valid_until: string;
      revoked_at: string | null;
      revoked_reason: string | null;
      expired_at: string | null;
      nft_contract_id: string | null;
      nft_minted_at: string | null;
      nft_burned_at: string | null;
      disclosure_blob_bytes: string;
      chain_submission_id: string | null;
      created_at: string;
    }>(sql`
      SELECT id::text, firm_id::text, user_ref, kyc_session_id::text,
             chain_contract_id, chain_network::text, operator_party,
             user_party, level::text, status::text, proof_hash,
             human_score,
             valid_from::text, valid_until::text,
             revoked_at::text, revoked_reason, expired_at::text,
             nft_contract_id, nft_minted_at::text, nft_burned_at::text,
             COALESCE(LENGTH(disclosure_blob_cache), 0)::text AS disclosure_blob_bytes,
             chain_submission_id, created_at::text
        FROM kyc_credentials_meta
       ORDER BY created_at ASC
    `);
    const sessionRows = await db.execute<{
      id: string;
      kind: string;
      customer_id: string | null;
      firm_id: string | null;
      user_ref: string | null;
      workflow: string;
      status: string;
      didit_session_id: string | null;
      failure_reason: string | null;
      started_at: string;
      completed_at: string | null;
    }>(sql`
      SELECT id::text, kind::text, customer_id::text, firm_id::text,
             user_ref, workflow::text, status::text, didit_session_id,
             failure_reason, started_at::text, completed_at::text
        FROM kyc_sessions
       ORDER BY started_at ASC
    `);
    const handoffRows = await db.execute<{
      id: string;
      customer_id: string;
      session_id: string;
      consumed_at: string | null;
      created_at: string;
    }>(sql`
      SELECT id::text, customer_id::text, session_id::text,
             consumed_at::text, created_at::text
        FROM kyc_device_handoffs
       ORDER BY created_at ASC
    `);
    // Drizzle's sql tag binds JS arrays as JSON-like records, not as
    // Postgres array literals. Build the action-list IN clause as a
    // sql.raw expression so the values land as quoted SQL literals.
    const actionListSql = sql.raw(
      KYC_AUDIT_ACTION_EXACT.map((a) => `'${a.replace(/'/g, "''")}'`).join(','),
    );
    const auditCountRow = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM audit_log
       WHERE action IN (${actionListSql})
          OR action LIKE 'customer.kyc_%'
          OR action LIKE 'kyc_session.%'
          OR action LIKE 'kyc_reconciler.%'
          OR action LIKE 'fraud.%'
    `);
    const notificationCountRow = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM notifications
       WHERE type LIKE 'kyc.%'
          OR type LIKE 'kyc_%'
    `);
    const ipAbuseCountRow = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM ip_abuse_signals`,
    );

    const counts = {
      customers: Number.parseInt(customerCount.rows[0]!.count, 10),
      credentials: credentialRows.rows.length,
      sessions: sessionRows.rows.length,
      handoffs: handoffRows.rows.length,
      auditRows: Number.parseInt(auditCountRow.rows[0]!.count, 10),
      notifications: Number.parseInt(notificationCountRow.rows[0]!.count, 10),
      ipAbuseRows: Number.parseInt(ipAbuseCountRow.rows[0]!.count, 10),
    };

    console.log('=== Pre-wipe counts ===');
    console.log(`  customers (kept):       ${counts.customers}`);
    console.log(`  kyc_credentials_meta:   ${counts.credentials}`);
    console.log(`  kyc_sessions:           ${counts.sessions}`);
    console.log(`  kyc_device_handoffs:    ${counts.handoffs}`);
    console.log(`  audit_log (kyc family): ${counts.auditRows}`);
    console.log(`  notifications (kyc.*):  ${counts.notifications}`);
    console.log(`  ip_abuse_signals:       ${counts.ipAbuseRows}`);

    /* ---------- Build the archive bundle ---------- */

    const archive: ArchiveBundle = {
      generatedAt: new Date().toISOString(),
      // Mask credentials in the URL so the archive can be safely
      // committed if a developer needs to attach it to a ticket.
      databaseUrl: databaseUrl.replace(/:[^:@/]+@/, ':****@'),
      counts,
      credentials: credentialRows.rows.map((r) => ({
        id: r.id,
        firmId: r.firm_id,
        userRef: r.user_ref,
        kycSessionId: r.kyc_session_id,
        chainContractId: r.chain_contract_id,
        chainNetwork: r.chain_network,
        operatorParty: r.operator_party,
        userParty: r.user_party,
        level: r.level,
        status: r.status,
        proofHash: r.proof_hash,
        humanScore: r.human_score,
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        revokedAt: r.revoked_at,
        revokedReason: r.revoked_reason,
        expiredAt: r.expired_at,
        nftContractId: r.nft_contract_id,
        nftMintedAt: r.nft_minted_at,
        nftBurnedAt: r.nft_burned_at,
        disclosureBlobBytes: Number.parseInt(r.disclosure_blob_bytes, 10),
        chainSubmissionId: r.chain_submission_id,
        createdAt: r.created_at,
      })),
      sessions: sessionRows.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        customerId: r.customer_id,
        firmId: r.firm_id,
        userRef: r.user_ref,
        workflow: r.workflow,
        status: r.status,
        diditSessionId: r.didit_session_id,
        failureReason: r.failure_reason,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      })),
      handoffs: handoffRows.rows.map((r) => ({
        id: r.id,
        customerId: r.customer_id,
        sessionId: r.session_id,
        consumedAt: r.consumed_at,
        createdAt: r.created_at,
      })),
    };

    const archiveDir = resolve(here, '../.archive');
    mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const archivePath = resolve(archiveDir, `kyc-fresh-start-${stamp}.json`);
    writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf8');
    console.log(`\nArchive written to: ${archivePath}`);

    if (dryRun) {
      console.log('\n[dry-run] No DB rows were modified.');
      console.log('Re-run with --confirm to execute the wipe.');
      return;
    }

    /* ---------- Destructive pass — single transaction ---------- */

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Drop credential metadata first. `kyc_sessions` has a
      //    SET NULL FK from `kyc_credentials_meta.kyc_session_id`, so
      //    deleting credentials before sessions avoids a transient
      //    NULL backfill.
      const credDelete = await client.query(`DELETE FROM kyc_credentials_meta`);

      // 2. Device handoffs (FK CASCADE on customers, but we want the
      //    rows gone regardless of customer presence).
      const handoffDelete = await client.query(`DELETE FROM kyc_device_handoffs`);

      // 3. KYC sessions (both kinds — `customer` + `b2b`).
      const sessionDelete = await client.query(`DELETE FROM kyc_sessions`);

      // 4. Audit-log rows in the customer-KYC family. Four patterns
      //    + an exact-list set so the deletion is comprehensive but
      //    surgical (firm/admin actions stay). The `customer.kyc_%`
      //    LIKE is broad on purpose — every variant
      //    (`customer.kyc_started/completed/reset/expired/failed/
      //    in_review/resubmission_requested/revoked_by_didit_user`)
      //    falls under it, and any future verb added to the catalog
      //    is wiped automatically without a script edit.
      const auditDelete = await client.query(
        `DELETE FROM audit_log
          WHERE action = ANY($1::text[])
             OR action LIKE 'customer.kyc_%'
             OR action LIKE 'kyc_session.%'
             OR action LIKE 'kyc_reconciler.%'
             OR action LIKE 'fraud.%'`,
        [KYC_AUDIT_ACTION_EXACT],
      );

      // 5. Customer-facing notifications about KYC.
      const notifDelete = await client.query(
        `DELETE FROM notifications
          WHERE type LIKE 'kyc.%'
             OR type LIKE 'kyc_%'`,
      );

      // 6. IP-abuse fingerprint store (anti-evader gate). Wipe so a
      //    fresh test sweep starts from a clean slate.
      const ipAbuseDelete = await client.query(`DELETE FROM ip_abuse_signals`);

      // 7. Reset every customer to baseline. customer.kyc_fields_locked
      //    → false makes the column writable again on the next start
      //    flow; revoked_at + revoked_reason cleared so the start
      //    handler doesn't refuse to spin up a fresh Didit session.
      const customerUpdate = await client.query(`
        UPDATE customers
           SET kyc_level = 'kyc_0',
               kyc_score = 0,
               kyc_fields_locked = false,
               revoked_at = NULL,
               revoked_reason = NULL,
               updated_at = NOW()
         WHERE deleted_at IS NULL
      `);

      await client.query('COMMIT');

      console.log('\n=== Wipe completed ===');
      console.log(`  kyc_credentials_meta deleted: ${credDelete.rowCount ?? 0}`);
      console.log(`  kyc_device_handoffs deleted:  ${handoffDelete.rowCount ?? 0}`);
      console.log(`  kyc_sessions deleted:         ${sessionDelete.rowCount ?? 0}`);
      console.log(`  audit_log deleted:            ${auditDelete.rowCount ?? 0}`);
      console.log(`  notifications deleted:        ${notifDelete.rowCount ?? 0}`);
      console.log(`  ip_abuse_signals deleted:     ${ipAbuseDelete.rowCount ?? 0}`);
      console.log(`  customers reset to kyc_0:     ${customerUpdate.rowCount ?? 0}`);
      console.log(`\nArchive: ${archivePath}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error('Fresh-start failed:');
  console.error(err);
  process.exit(1);
});
