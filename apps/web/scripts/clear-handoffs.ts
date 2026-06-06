/**
 * One-off dev script: clear un-consumed KYC device handoffs for a
 * customer (by email substring). Used when the per-session cap of 5
 * un-consumed tokens is hit during testing and we want to free the
 * session up without waiting 10 min for the TTL.
 *
 * Soft-clear (recommended): marks rows consumed_at = now() so the
 * `MAX_HANDOFFS_PER_SESSION` count drops to zero. Burned tokens stay
 * archived for the audit trail; future regeneration starts a fresh
 * counter.
 *
 * Usage:
 *   pnpm --filter @crivacy/web exec tsx scripts/clear-handoffs.ts <email-substring>
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv(resolve(here, '../.env'));
  loadEnv(resolve(here, '../.env.local'));

  const pattern = process.argv[2];
  if (pattern === undefined || pattern.length === 0) {
    console.error('Usage: tsx scripts/clear-handoffs.ts <email-substring>');
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

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

    const cleared = await db.execute<{ id: string; session_id: string }>(sql`
      UPDATE kyc_device_handoffs
      SET consumed_at = NOW(), device_info = COALESCE(device_info, 'cleared-by-dev-script')
      WHERE customer_id = ${customer.id}
        AND consumed_at IS NULL
      RETURNING id, session_id
    `);

    console.log(`Cleared ${cleared.rows.length} un-consumed handoff(s).`);
    for (const row of cleared.rows) {
      console.log(`  - handoff ${row.id} (session ${row.session_id})`);
    }
  } finally {
    await pool.end();
  }
}

void main();
