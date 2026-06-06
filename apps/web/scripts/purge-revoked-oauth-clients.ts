/**
 * One-off dev cleanup: hard-delete every OAuth client whose
 * `revoked_at` column is set, along with its FK-cascaded children
 * (oauth_consents, oauth_authorization_codes,
 * oauth_authorization_requests, oauth_access_tokens).
 *
 * Usage:
 *   pnpm --filter @crivacy/web exec tsx scripts/purge-revoked-oauth-clients.ts
 *
 * Guard: refuses to run unless `NODE_ENV === 'development'` — the
 * real production answer is soft-delete + audit retention, not
 * hard delete. Only use this to clean up test-firm scratch data
 * during integration work.
 *
 * Audit rows that reference the deleted clients are NOT removed;
 * they stay as historical breadcrumbs (the audit log is supposed
 * to outlive the underlying row by design).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load `.env` from apps/web manually — the project doesn't have
// `dotenv` as a dependency and Node's `--env-file` flag wants a CLI
// arg we can't guarantee. A 20-line parser covers the shapes the
// project actually uses (KEY=VALUE, quoted or bare, blank lines, #
// comments).
function loadEnvFile(path: string): void {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(resolve(here, '..', '.env'));
loadEnvFile(resolve(here, '..', '.env.local'));

const { Pool } = pg;

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'development') {
    console.error(
      '[purge-revoked-oauth-clients] Refusing to run outside NODE_ENV=development. Soft-delete is the production answer.',
    );
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error('[purge-revoked-oauth-clients] DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    const before = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM oauth_clients WHERE revoked_at IS NOT NULL`,
    );
    const beforeCount = Number.parseInt(before.rows[0]?.count ?? '0', 10);

    if (beforeCount === 0) {
      console.log('[purge-revoked-oauth-clients] No revoked clients to delete.');
      return;
    }

    console.log(`[purge-revoked-oauth-clients] Deleting ${beforeCount} revoked client(s)...`);

    // Single DELETE triggers ON DELETE CASCADE on every child FK
    // (oauth_consents, oauth_authorization_requests,
    // oauth_authorization_codes, oauth_access_tokens). One statement,
    // atomic.
    const result = await db.execute(
      sql`DELETE FROM oauth_clients WHERE revoked_at IS NOT NULL RETURNING id, client_id, name`,
    );

    for (const row of result.rows as Array<Record<string, unknown>>) {
      console.log(
        `  - deleted ${String(row['client_id'])} (${String(row['name'])}) [${String(row['id'])}]`,
      );
    }
    console.log(`[purge-revoked-oauth-clients] Done. Removed ${result.rows.length} row(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[purge-revoked-oauth-clients] Failed:', err);
  process.exit(1);
});
