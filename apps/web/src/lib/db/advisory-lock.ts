/**
 * Postgres advisory locks for serialising per-firm create flows.
 *
 * Tier caps on API keys, OAuth clients, and webhook endpoints all
 * share the same TOCTOU shape: the handler reads the row count,
 * compares against the cap, then inserts. Two create requests for
 * the same firm arriving at the same second each observe the
 * pre-insert count, both decide they're under the limit, and both
 * insert — silently bumping the firm one slot over tier.
 *
 * Postgres's `pg_advisory_xact_lock` serialises concurrent
 * transactions on an integer key. We derive the key from
 * `hashtext(<stable string>)`, scoping it per-firm + per-resource
 * so unrelated flows never contend:
 *
 *   * `firm:<uuid>:oauth_clients` — OAuth client create
 *   * `firm:<uuid>:api_keys` — API key create / rotate-to-new
 *   * `firm:<uuid>:webhook_endpoints` — webhook endpoint create
 *
 * The lock is released automatically when the transaction commits
 * or rolls back, so no cleanup path is required. Two different
 * firms creating resources of the same type proceed in parallel
 * because their hashed keys differ.
 *
 * `hashtext(text) → integer` is a 32-bit Postgres builtin — not
 * cryptographic, but we only need collision-avoidance across the
 * handful of resource names in this codebase, and each key is
 * namespaced by the firm id anyway.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

/**
 * Resources that share a per-firm tier cap. Adding a new one here
 * is all that's needed to thread a new create flow through the
 * lock — callers pass the tag and the helper builds the namespaced
 * key.
 */
export type LockedFirmResource = 'oauth_clients' | 'api_keys' | 'webhook_endpoints';

/**
 * Acquire a transaction-scoped advisory lock that serialises
 * concurrent create calls for a `(firmId, resource)` pair.
 *
 * MUST be called from inside a `db.transaction(async (tx) => …)`
 * callback — the lock's lifetime is the transaction's. Calling
 * against the root `db` handle would acquire a session-level lock
 * that nothing ever releases.
 */
export async function acquireFirmResourceLock(
  tx: CrivacyDatabase,
  firmId: string,
  resource: LockedFirmResource,
): Promise<void> {
  const key = `firm:${firmId}:${resource}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
