/**
 * Standalone migration runner invoked by `pnpm --filter @crivacy/web db:migrate`.
 *
 * This script is run:
 *   * Locally during development after `drizzle-kit generate`.
 *   * By the container entrypoint during deploy (step 21) before the
 *     Next.js server starts, inside a transaction that holds an
 *     advisory lock so concurrent replicas serialize.
 *
 * It is deliberately isolated from the Next.js process so it can run
 * in a minimal Node container without bundling the web app.
 */

import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { getRootLogger } from '@/lib/observability/logger';
import { DEFAULT_DATABASE_CLIENT_CONFIG, createDatabaseClient } from './client';

/**
 * Advisory-lock key used to serialize concurrent migration runs. A
 * readable date-stamp is preferred over a random number so operators
 * can grep for the value in `pg_locks` during incidents. The literal
 * is well inside `Number.MAX_SAFE_INTEGER` so node-postgres can
 * serialize it directly to Postgres `bigint`.
 */
const LOCK_KEY = 20_260_411_01 as const;

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const handle = createDatabaseClient({
    ...DEFAULT_DATABASE_CLIENT_CONFIG,
    connectionString,
    statementTimeoutMs: 300_000,
    idleInTransactionTimeoutMs: 300_000,
    applicationName: 'crivacy-migrations',
  });

  const started = Date.now();
  try {
    const lockClient = await handle.pool.connect();
    try {
      await lockClient.query('select pg_advisory_lock($1)', [LOCK_KEY]);
      try {
        // `new URL(...).pathname` returns an inverted / prefixed path on
        // Windows (e.g. `/C:/Users/...`), which drizzle's fs-based
        // migrator can't `readFileSync` against. Route through
        // `fileURLToPath` so the same call yields a valid native path
        // on both Linux (Docker runtime) and Windows (local dev).
        const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
        await migrate(handle.db, {
          migrationsFolder,
          migrationsTable: 'crivacy_migrations',
          migrationsSchema: 'public',
        });
      } finally {
        await lockClient.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      lockClient.release();
    }
  } finally {
    await handle.close();
  }

  // Structured single-line JSON routed through pino so the deploy
  // pipeline's Promtail ships the migration-complete event to Loki
  // with the same shape as every other application log.
  getRootLogger().info(
    { event: 'migrations_completed', durationMs: Date.now() - started },
    'migrations completed',
  );
}

main().catch((error: unknown) => {
  getRootLogger().error(
    {
      event: 'migrations_failed',
      err: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    },
    'migrations failed',
  );
  process.exit(1);
});
