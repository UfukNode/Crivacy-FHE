/**
 * Public barrel for `@/lib/db`.
 *
 * Callers should import from this file, never from the underlying
 * `schema/` or `client.ts` modules directly. This keeps the
 * application-facing surface small and lets us refactor internals
 * (e.g. switching from node-postgres to postgres.js) without a
 * repo-wide sweep.
 */

export {
  createDatabaseClient,
  DEFAULT_DATABASE_CLIENT_CONFIG,
  getDatabaseClient,
  resetDatabaseClientForTests,
  type CrivacyDatabase,
  type DatabaseClientConfig,
  type DatabaseClientHandle,
} from './client';

export * from './schema';
