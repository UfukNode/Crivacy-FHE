/**
 * OAuth state JWT single-use burn.
 *
 * The customer-side Google OAuth flow mints two short-lived signed
 * tokens that must each verify exactly once:
 *
 *   - State JWT (10 min) — minted at `/auth/google/initiate`,
 *     consumed at `/auth/google/callback`. Single-use is critical
 *     because the same cookie+state pair, once stolen, would
 *     otherwise replay against the callback for the full TTL.
 *
 *   - Confirm-link JWT (10 min) — minted by the callback's auto-
 *     link branch (F-A2-C2-001), consumed at
 *     `/auth/google/confirm-link`. URL-token transport means a
 *     logged URL or browser history snapshot must not be replayable
 *     even with the user's password.
 *
 * Cookie-deletion alone (the prior pattern) only enforces single-
 * use on the originating browser; an XSS or browser-clone scenario
 * trivially bypasses it. Burn-at-rest closes that gap by writing
 * the JWT's `jti` to a dedicated table and rejecting any subsequent
 * verify that lands the same `jti`.
 *
 * Same primitive (`runOrCatchUnique` on the `oauth_state_used`
 * primary-key index) used by the wallet-nonce burn (`claimWalletNonce`)
 * and the TOTP code burn (`verifyAndConsumeTotpCode`).
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { runOrCatchUnique } from '@/lib/db/unique-violation';

/**
 * Atomically claim a JWT `jti` as consumed. Returns `true` when the
 * row was inserted (caller is the first consumer), `false` when the
 * primary-key collision fired (a prior verify already consumed this
 * token — replay attempt).
 *
 * Performs an opportunistic cleanup of expired rows on every call.
 * Cost is negligible at production traffic volume (OAuth flow rate),
 * and the alternative (cron job) adds operational surface that this
 * one-table problem doesn't justify.
 *
 * `customerId` is optional — login-mode state tokens don't know the
 * customer ID until they unwrap. Confirm-link tokens carry one.
 */
export async function claimOAuthStateJti(
  db: CrivacyDatabase,
  jti: string,
  ttlExpiresAt: Date,
  customerId: string | null,
): Promise<boolean> {
  // Opportunistic prune — rows past their TTL cannot contribute to
  // any replay (the underlying JWT is already expired) so dropping
  // them costs nothing.
  await db.execute(
    sql`DELETE FROM oauth_state_used WHERE ttl_expires_at < NOW()`,
  );

  const result = await runOrCatchUnique(
    () =>
      db.execute(
        sql`INSERT INTO oauth_state_used (jti, customer_id, ttl_expires_at)
         VALUES (${jti}, ${customerId}, ${ttlExpiresAt.toISOString()})`,
      ),
    ['oauth_state_used_pkey'],
  );

  return result.status === 'ok';
}
