/**
 * Apply post-baseline SQL migrations not tracked in Drizzle's _journal.json.
 *
 * Background: `src/lib/db/migrations/_journal.json` only tracks the
 * baseline snapshot. Every SQL we've added since (wallet_nonces_used,
 * idempotency_keys, sessions_remember_me, etc.) was applied manually
 * via `docker exec psql`. That works for the current dev machine but
 * breaks fresh installs (new dev, CI, prod deploy) — they'd see
 * baseline only and miss 14+ migrations.
 *
 * This script is the canonical "apply all SQL migrations" runner for
 * those paths. It uses the same `crivacy_migrations` table that
 * Drizzle's migrator uses (hash-keyed) so a later journal rebuild
 * can recognise applied entries.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... pnpm tsx scripts/apply-sql-migrations.ts
 *
 * Behavior:
 *   - Lists every `*.sql` in `src/lib/db/migrations/` (sorted lexicographically).
 *   - For each, computes SHA-256 of the file bytes.
 *   - Skips if hash already in `crivacy_migrations`.
 *   - Otherwise applies inside a transaction + INSERT the hash.
 *
 * Safe to run multiple times — idempotent via the hash index.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/lib/db/migrations',
);

const ADVISORY_LOCK_KEY = 20_260_411_02 as const;

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required.');
  }

  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  try {
    // Serialize concurrent runners via advisory lock.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    // Ensure the tracking table exists (Drizzle creates it on first
    // migrate() — we mirror its shape so both runners interop).
    await client.query(`
      CREATE TABLE IF NOT EXISTS crivacy_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // eslint-disable-next-line no-console
    console.log(`[sql-migrations] Found ${String(files.length)} SQL files.`);

    let applied = 0;
    let skipped = 0;

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = readFileSync(fullPath, 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');

      const existing = await client.query<{ id: number }>(
        'select id from crivacy_migrations where hash = $1 limit 1',
        [hash],
      );
      if (existing.rows.length > 0) {
        skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-console
      console.log(`[sql-migrations] Applying ${file} ...`);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(
          'insert into crivacy_migrations (hash, created_at) values ($1, $2)',
          [hash, Date.now()],
        );
        await client.query('commit');
        applied += 1;
      } catch (err) {
        await client.query('rollback');
        throw new Error(
          `Failed to apply ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[sql-migrations] Done. applied=${String(applied)} skipped=${String(skipped)}`,
    );
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
