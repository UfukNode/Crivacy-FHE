/**
 * One-off dev script: clear ACTIVE KYC sessions for a customer
 * (matched by email substring) — i.e. flip every
 * `pending / in_progress / in_review / identity_approved /
 * address_in_progress / resubmission_pending` row to `revoked`.
 *
 * This is the surgical "no leftover continue-button after a half-baked
 * Didit flow" cleaner — used before screen recordings / live demos so
 * the customer lands on a clean "Start identity verification" CTA
 * instead of the stale "Continue identity verification" left over
 * from an earlier abandoned attempt.
 *
 *   ⚠ This is NOT a KYC reset. Credentials, kyc_level, NFT contract id,
 *     decline counters, ban state, etc. are ALL untouched. If the
 *     customer was kyc_2 before the script ran, they are still kyc_2
 *     after.  Use `reset-all-kyc-fresh-start.ts` (different script)
 *     when you need the full wipe.
 *
 * SoT-respecting: delegates to `revokeActiveKycSessions` from
 * `lib/customer/kyc-reset.ts`. Same helper the Didit user-entity
 * webhook + admin reset_kyc + cascade-ban + reconciler reverse-drift
 * pass call. Adding a new active status to
 * `ACTIVE_SESSION_STATUSES` widens what this script touches without
 * any code change here.
 *
 * Side-effect cleanup: also marks un-consumed handoff tokens as
 * consumed (same pattern as `clear-handoffs.ts`) so the per-session
 * `MAX_HANDOFFS_PER_SESSION` counter doesn't carry over and surface
 * "too many handoff attempts" on the next fresh session.
 *
 * Monthly budget reset (added 2026-05-11):
 *   - `handleStartIdentity` / `handleStartAddress` enforce a rolling
 *     30-day cap of `MONTHLY_SESSION_CAP_PER_CUSTOMER = 20` over
 *     every `kyc_sessions` row regardless of status (including
 *     `revoked` / `expired`). Step 1 above doesn't drop that counter
 *     — a customer who burned 20 attempts then ran this script
 *     would still see "You have reached the monthly verification
 *     limit."
 *   - Fix: backdate `created_at` on every row inside the budget
 *     window so the COUNT(*) drops to zero. Backdate is a 31-day
 *     shift (`MONTHLY_WINDOW_MS + 1 day` buffer); a DELETE would
 *     break FK refs from `kyc_credentials_meta` /
 *     `kyc_device_handoffs` and would lose the audit history every
 *     downstream consumer reads.
 *   - Also resets `customers.consecutive_kyc_declines` /
 *     `last_decline_at` so the Plan B decline-lock cooldown counter
 *     starts at zero — without this a customer with 3+ recent
 *     declines would land in the cooldown panel even after the
 *     budget counter cleared.
 *
 * Usage:
 *   pnpm --filter @crivacy/web exec tsx scripts/clear-active-kyc-sessions.ts <email-substring>
 *
 *   Refuses to run when DATABASE_URL points outside localhost /
 *   127.0.0.1 — same prod-safety pin the fresh-start script uses.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import { revokeActiveKycSessions } from '@/lib/customer/kyc-reset';
import type { CrivacyDatabase } from '@/lib/db/client';

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

function assertLocalDatabase(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    console.error('DATABASE_URL is not a valid URL.');
    process.exit(1);
  }
  const host = parsed.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.error(
      `Refusing to run: DATABASE_URL host is "${host}" (not localhost / 127.0.0.1). ` +
        'This script is a local-only dev helper.',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv(resolve(here, '../.env'));
  loadEnv(resolve(here, '../.env.local'));

  const pattern = process.argv[2];
  if (pattern === undefined || pattern.length === 0) {
    console.error('Usage: tsx scripts/clear-active-kyc-sessions.ts <email-substring>');
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  assertLocalDatabase(databaseUrl);

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool) as unknown as CrivacyDatabase;

  try {
    const lookup = await db.execute<{ id: string; email: string | null }>(sql`
      SELECT id, email
      FROM customers
      WHERE email ILIKE ${'%' + pattern + '%'}
      LIMIT 5
    `);
    if (lookup.rows.length === 0) {
      console.error(`No customer matched email substring "${pattern}".`);
      process.exit(1);
    }
    if (lookup.rows.length > 1) {
      console.log('Multiple matches:');
      for (const row of lookup.rows) {
        console.log(`  - ${row.id}  ${row.email}`);
      }
      console.error('Refine the pattern.');
      process.exit(1);
    }
    const customer = lookup.rows[0]!;
    console.log(`Customer: ${customer.id}  ${customer.email}`);

    // SoT-respecting revoke. Same helper Didit user-entity webhook +
    // admin reset_kyc + cascade-ban + reconciler reverse-drift call,
    // so any future widening of `ACTIVE_SESSION_STATUSES` flows here
    // automatically.
    const revoked = await revokeActiveKycSessions(
      db,
      customer.id,
      new Date(),
      'cleared-by-dev-script',
    );
    console.log(`Revoked ${revoked} active kyc_session(s).`);

    // Companion cleanup: un-consumed handoff tokens. Without this the
    // per-session `MAX_HANDOFFS_PER_SESSION` counter would survive the
    // revoke and surface "too many handoff attempts" on the next
    // fresh session — same trap `clear-handoffs.ts` already worked
    // around in isolation.
    const handoffs = await db.execute<{ id: string }>(sql`
      UPDATE kyc_device_handoffs
      SET consumed_at = NOW(), device_info = COALESCE(device_info, 'cleared-by-dev-script')
      WHERE customer_id = ${customer.id}
        AND consumed_at IS NULL
      RETURNING id
    `);
    console.log(`Cleared ${handoffs.rows.length} un-consumed handoff token(s).`);

    // Monthly budget reset. Backdate every kyc_sessions row whose
    // `created_at` is inside the 30-day budget window so it falls
    // OUT of the COUNT(*) the start handlers run. Backdate value:
    // 31 days ago — one-day buffer over `MONTHLY_WINDOW_MS` so a
    // start request immediately after the script doesn't land at
    // exactly the window boundary. Returning row count so we can
    // log "monthly cap cleared" only when the script actually had
    // an effect.
    const budgetReset = await db.execute<{ id: string }>(sql`
      UPDATE kyc_sessions
      SET created_at = NOW() - INTERVAL '31 days'
      WHERE customer_id = ${customer.id}
        AND created_at > NOW() - INTERVAL '30 days'
      RETURNING id
    `);
    console.log(
      `Backdated ${budgetReset.rows.length} kyc_sessions row(s) — monthly budget counter reset.`,
    );

    // Decline-lock counter reset. The Plan B cooldown gate
    // (`evaluateDeclineLock`) reads
    // `customers.consecutive_kyc_declines` + `last_decline_at`; if
    // those say "3 declines, last one 10 min ago" the gate trips
    // even after the budget counter clears. Zero them.
    const declineReset = await db.execute<{ id: string }>(sql`
      UPDATE customers
      SET consecutive_kyc_declines = 0,
          last_decline_at = NULL
      WHERE id = ${customer.id}
        AND (consecutive_kyc_declines > 0 OR last_decline_at IS NOT NULL)
      RETURNING id
    `);
    if (declineReset.rows.length > 0) {
      console.log('Reset decline counter + cooldown timestamp on customer row.');
    }

    if (
      revoked === 0 &&
      handoffs.rows.length === 0 &&
      budgetReset.rows.length === 0 &&
      declineReset.rows.length === 0
    ) {
      console.log('Nothing to clear — customer already has a fresh slate.');
    }
  } finally {
    await pool.end();
  }
}

void main();
