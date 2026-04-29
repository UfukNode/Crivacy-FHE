import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { getRootLogger } from '@/lib/observability/logger';
import * as schema from './schema';

/**
 * The concrete type our repository layer imports. Consumers should never
 * construct their own client — they accept a `CrivacyDatabase` and call
 * methods on it. This gives us a single place to switch drivers (e.g. to
 * `postgres.js` or an HTTP gateway) without touching the query code.
 */
export type CrivacyDatabase = NodePgDatabase<typeof schema>;

/**
 * Configuration surface for {@link createDatabaseClient}. Every knob is
 * explicit — we do not read `process.env` inside the factory so tests
 * can inject their own values and so accidental fallback to a stale
 * env var is impossible.
 */
export interface DatabaseClientConfig {
  /** `postgres://user:pass@host:port/db` — required, no default. */
  readonly connectionString: string;
  /** Upper bound on simultaneous connections held by this pool. */
  readonly maxConnections: number;
  /** Time to wait for a free connection before rejecting (ms). */
  readonly connectionTimeoutMs: number;
  /** Idle-to-close timeout for pool connections (ms). */
  readonly idleTimeoutMs: number;
  /** Query-level statement timeout (ms). */
  readonly statementTimeoutMs: number;
  /** Transaction idle-in-transaction session timeout (ms). */
  readonly idleInTransactionTimeoutMs: number;
  /** Passed through to `pg.Pool` when TLS is required by the server. */
  readonly ssl: pg.PoolConfig['ssl'];
  /** Application name sent to Postgres for observability. */
  readonly applicationName: string;
}

/**
 * Everything {@link createDatabaseClient} returns. The drizzle wrapper is
 * first-class, but we also surface the raw pool so background workers
 * and migration tooling can obtain a checked-out client.
 */
export interface DatabaseClientHandle {
  /**
   * Default drizzle handle — currently bound to the `admin` pool for
   * end-to-end backward compatibility. Existing call sites that
   * imported `getDatabaseClient().db` behave identically. Once every
   * firm-scoped handler is migrated onto the `app` pool and RLS is
   * enabled in phases 7+, callers that want BYPASSRLS should switch
   * to `.admin` explicitly; the `.db` alias stays as a convenience.
   */
  readonly db: CrivacyDatabase;
  /**
   * RLS-enforced pool. Handler middleware (`dashboardRoute`,
   * `apiRoute`) sets `SET LOCAL app.firm_id = $fid` inside a
   * per-request transaction against this pool; policies added in
   * phases 7-15 filter every row to the calling firm's data only.
   *
   * Until policies ship, this pool is functionally identical to
   * `admin` — we already created the `crivacy_app` role and granted
   * it DML in migration `20260425120000_rls_roles_grants.sql`, but
   * no table has `ENABLE ROW LEVEL SECURITY` yet. Handlers can start
   * using it immediately; behaviour only changes when a table gets
   * its first policy.
   *
   * Falls back to the admin pool when `DATABASE_URL_APP` is unset
   * (dev default) — see {@link getDatabaseClient}.
   */
  readonly app: CrivacyDatabase;
  /**
   * BYPASSRLS pool. Admin routes, pg-boss workers, migration tooling,
   * and any code path that must see every firm's rows connect here.
   * Until RLS policies ship the distinction is nominal, but wiring
   * admin / worker call sites onto this pool in phases 4-5 means the
   * policy rollout in phases 7+ is a schema change only — no
   * middleware churn required at the same time.
   */
  readonly admin: CrivacyDatabase;
  /**
   * Raw admin pool for places that need a checked-out `pg.Client`
   * (advisory-lock serialisation, migration runner). Handlers should
   * never touch this — use `app` or `admin` above.
   */
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
}

/**
 * Build a single pool + drizzle wrapper pair for a given configuration.
 * Internal helper — most call sites should use
 * {@link createDatabaseClient} which spins up both the `app` and
 * `admin` pools side-by-side.
 */
function createPoolAndDrizzle(
  config: DatabaseClientConfig,
  poolLabel: 'app' | 'admin' | 'default',
): { pool: pg.Pool; db: CrivacyDatabase } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    application_name: `${config.applicationName}:${poolLabel}`,
    ssl: config.ssl,
  });

  pool.on('error', (error) => {
    // Do not rethrow — `pg.Pool` emits `error` for idle-client failures
    // that are already retried automatically on the next checkout.
    // Routed through pino so each occurrence lands in Loki as a
    // structured event the pool-errors alert can count on. `poolLabel`
    // in the log lets a single alert rule split app vs admin pool
    // failures without changing its query shape.
    getRootLogger().error(
      {
        event: 'db_pool_idle_error',
        poolLabel,
        err: { name: error.name, message: error.message, stack: error.stack },
      },
      'db pool idle client error',
    );
  });

  const db = drizzle(pool, { schema, logger: false });
  return { pool, db };
}

/**
 * Build two pool + drizzle wrapper pairs for a given configuration —
 * one bound to the NOBYPASSRLS `crivacy_app` role, one to the
 * BYPASSRLS `crivacy_admin` role. When `appConnectionString` is
 * omitted, both handles point at the admin pool (dev / back-compat).
 *
 * Concurrent calls with the same configuration do not share pools —
 * that is intentional. Singletons live in {@link getDatabaseClient} so
 * this pure factory stays trivially unit-testable.
 */
export function createDatabaseClient(
  config: DatabaseClientConfig,
  appConfig?: Pick<DatabaseClientConfig, 'connectionString'>,
): DatabaseClientHandle {
  const admin = createPoolAndDrizzle(config, 'admin');

  // If no explicit app-role connection string is provided we alias
  // `app` onto `admin`. Faz 7+ adds RLS policies — until then the
  // fallback is fully equivalent to the admin pool, so handler
  // migrations can land incrementally without requiring every
  // environment to configure a second DATABASE_URL.
  let app: { pool: pg.Pool; db: CrivacyDatabase };
  let appIsAliased: boolean;
  if (appConfig !== undefined && appConfig.connectionString.length > 0) {
    app = createPoolAndDrizzle({ ...config, connectionString: appConfig.connectionString }, 'app');
    appIsAliased = false;
  } else {
    app = admin;
    appIsAliased = true;
  }

  return {
    db: admin.db,
    app: app.db,
    admin: admin.db,
    pool: admin.pool,
    close: async () => {
      await admin.pool.end();
      if (!appIsAliased) {
        await app.pool.end();
      }
    },
  };
}

/**
 * Default TCP timeouts and pool sizing for a single Next.js process. The
 * production backend runs two Next.js instances behind nginx (PLAN.md
 * step 21); each instance gets its own pool.
 */
export const DEFAULT_DATABASE_CLIENT_CONFIG: Omit<DatabaseClientConfig, 'connectionString'> = {
  maxConnections: 20,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 60_000,
  ssl: false,
  applicationName: 'crivacy-api',
};

/**
 * Pure resolver for the admin + app connection strings (AUDIT C-2).
 *
 * Split out of {@link getDatabaseClient} so the resolution rules — and
 * especially the production fail-fast below — are unit-testable without
 * spinning up real pools.
 *
 * Admin pool: `DATABASE_URL_ADMIN` preferred, `DATABASE_URL` fallback.
 * At least one must be set (empty string counts as unset).
 *
 * App pool (NOBYPASSRLS, the surface RLS policies filter): comes from
 * `DATABASE_URL_APP`. When unset, {@link createDatabaseClient} silently
 * aliases the app pool onto the admin (BYPASSRLS) pool — fine in dev,
 * but in production that makes every handler query run with RLS
 * bypassed, silently losing the cross-tenant isolation guarantee. So in
 * production we refuse to start unless `DATABASE_URL_APP` is set AND
 * distinct from the admin connection (an app pool pointed at the admin
 * connection is the same BYPASSRLS role, equally unsafe).
 */
export function resolveDatabaseConnections(env: {
  readonly DATABASE_URL_ADMIN?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_URL_APP?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}): { adminConnectionString: string; appConnectionString: string | undefined } {
  const adminEnv = env.DATABASE_URL_ADMIN;
  const fallbackEnv = env.DATABASE_URL;
  const adminConnectionString =
    adminEnv !== undefined && adminEnv.length > 0
      ? adminEnv
      : fallbackEnv !== undefined && fallbackEnv.length > 0
        ? fallbackEnv
        : undefined;
  if (adminConnectionString === undefined) {
    throw new Error(
      'No admin database connection string configured. Set either ' +
        'DATABASE_URL_ADMIN (preferred — Faz 4.5 explicit `crivacy_admin` ' +
        'binding) or DATABASE_URL (back-compat fallback). Copy ' +
        'apps/web/.env.example to apps/web/.env and fill in the credentials.',
    );
  }

  const appEnv = env.DATABASE_URL_APP;
  const appConnectionString = appEnv !== undefined && appEnv.length > 0 ? appEnv : undefined;

  if (env.NODE_ENV === 'production') {
    if (appConnectionString === undefined) {
      throw new Error(
        'DATABASE_URL_APP must be set in production. Without it the handler ' +
          'pool silently falls back to the BYPASSRLS admin connection, which ' +
          'disables Row-Level Security and breaks cross-tenant isolation. ' +
          'Point it at the NOBYPASSRLS `crivacy_app` role.',
      );
    }
    if (appConnectionString === adminConnectionString) {
      throw new Error(
        'DATABASE_URL_APP must not equal the admin connection string in ' +
          'production. The app pool would then connect as the BYPASSRLS role ' +
          'and Row-Level Security would be bypassed. Use the dedicated ' +
          'NOBYPASSRLS `crivacy_app` role for DATABASE_URL_APP.',
      );
    }
  }

  return { adminConnectionString, appConnectionString };
}

let cachedHandle: DatabaseClientHandle | null = null;

/**
 * Process-level singleton used by the API route handlers.
 *
 * Resolution order for the **admin pool** (BYPASSRLS — adminRoute,
 * pg-boss workers, migration runner, pre-auth lookups):
 *
 *   1. `DATABASE_URL_ADMIN` — explicit binding, introduced in
 *      Cat 34b RLS Faz 4.5. Production should use this so the admin
 *      pool connects as the dedicated `crivacy_admin` role created
 *      by migration `20260425120000_rls_roles_grants.sql`.
 *   2. `DATABASE_URL` — back-compat fallback. Dev / single-role
 *      deployments where the existing `crivacy` owner happens to
 *      carry BYPASSRLS continue to work without any env change.
 *
 * Resolution order for the **app pool** (NOBYPASSRLS — handler
 * surface, RLS policies in Faz 7+ filter every row):
 *
 *   1. `DATABASE_URL_APP` — explicit binding (`crivacy_app` role).
 *   2. Admin connection string — silent alias. Safe in dev where no
 *      table has RLS enabled yet, but in prod with Faz 7+ policies
 *      shipped, leaving this unset means every handler request runs
 *      as BYPASSRLS and the cross-tenant guarantee is lost.
 *
 * `DATABASE_URL_ADMIN` and `DATABASE_URL` are interchangeable for the
 * "admin pool" slot — at least one of them must be set, otherwise the
 * server cannot start. `DATABASE_URL_APP` is independent of both.
 *
 * Tests that need a different connection should use
 * {@link createDatabaseClient} directly and never touch this accessor.
 */
export function getDatabaseClient(): DatabaseClientHandle {
  if (cachedHandle !== null) {
    return cachedHandle;
  }

  // Admin + app connection resolution + production RLS fail-fast lives in
  // the pure `resolveDatabaseConnections` helper so it can be unit-tested
  // (AUDIT C-2).
  const { adminConnectionString, appConnectionString } = resolveDatabaseConnections({
    DATABASE_URL_ADMIN: process.env['DATABASE_URL_ADMIN'],
    DATABASE_URL: process.env['DATABASE_URL'],
    DATABASE_URL_APP: process.env['DATABASE_URL_APP'],
    NODE_ENV: process.env['NODE_ENV'],
  });

  const appConfig =
    appConnectionString !== undefined ? { connectionString: appConnectionString } : undefined;

  cachedHandle = createDatabaseClient(
    {
      ...DEFAULT_DATABASE_CLIENT_CONFIG,
      connectionString: adminConnectionString,
    },
    appConfig,
  );

  const shutdown = async (signal: string): Promise<void> => {
    if (cachedHandle === null) {
      return;
    }
    const handle = cachedHandle;
    cachedHandle = null;
    try {
      await handle.close();
    } catch (error) {
      // Final log-and-swallow: by the time we are in the SIGTERM path
      // there is no observer left to act on a rejection and we do not
      // want to stall the shutdown pipeline. Still routed through pino
      // so the line ships to Loki before the process exits.
      getRootLogger().error(
        {
          event: 'db_pool_close_error',
          signal,
          err: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        },
        'db pool close error during shutdown',
      );
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  return cachedHandle;
}

/**
 * Test helper: discard the cached singleton so the next call to
 * {@link getDatabaseClient} re-reads `process.env` and builds a fresh
 * pool. Only intended for use inside `tests/**`.
 */
export function resetDatabaseClientForTests(): void {
  cachedHandle = null;
}
