import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit configuration for `@crivacy/web`.
 *
 *   * `schema` — glob consumed by `drizzle-kit generate` to scan every
 *     table declaration. Points at the barrel so new files are picked up
 *     automatically via the `export *` chain.
 *   * `out`    — location of generated SQL migrations. The runtime
 *     `src/lib/db/migrate.ts` script reads from this same folder.
 *   * `dbCredentials.url` — only used by the CLI (`generate`, `check`,
 *     `studio`). The runtime Next.js process reads `DATABASE_URL`
 *     directly via `getDatabaseClient()`.
 *
 * Strict + verbose are enabled so CI catches schema drift and gives
 * operators an auditable migration diff.
 */
const config: Config = {
  schema: './src/lib/db/schema/index.ts',
  out: './src/lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://crivacy:crivacy@127.0.0.1:5433/crivacy',
  },
  strict: true,
  verbose: true,
  migrations: {
    table: 'crivacy_migrations',
    schema: 'public',
    prefix: 'timestamp',
  },
  casing: 'snake_case',
};

export default config;
