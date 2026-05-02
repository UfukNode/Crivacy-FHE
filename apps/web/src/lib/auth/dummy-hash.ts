/**
 * Timing-uniformity dummy hash.
 *
 * Every login handler (customer, firm, admin) pays the same argon2id
 * verify cost on every bail-out branch so a remote attacker cannot
 * tell "email unknown" from "email known, wrong password" from
 * "account banned / locked / no password set" by timing. This module
 * provides the shared primitive: a lazily computed hash the handlers
 * run `verifyPassword` against on every branch that would otherwise
 * return without real work.
 *
 * The cached promise is populated on the first call in the process
 * and reused for its lifetime. Rejected cache states auto-reset so a
 * transient argon2 failure doesn't brick the whole auth surface.
 *
 * @module
 */

import type { AuthConfig } from './config';
import { hashPassword } from './password';

let cachedDummyHashPromise: Promise<string> | null = null;

/**
 * Hardcoded plaintext used to seed the dummy hash. Never compared
 * against user input — we only need a hash that parses as argon2id
 * with the configured cost factors so a real verify against it takes
 * the same wall-clock time as a verify against any user row. 128
 * characters clears every plausible `passwordMinLength` policy
 * without leaking anything.
 */
const DUMMY_PLAINTEXT = 'd'.repeat(128);

/**
 * Return the cached dummy argon2id hash (lazy).
 *
 * Callers pass the current `AuthConfig` so the hash's cost factors
 * match the real password column on first call. Subsequent calls
 * ignore the argument and return the memoised promise.
 */
export async function getDummyPasswordHash(config: AuthConfig): Promise<string> {
  if (cachedDummyHashPromise === null) {
    cachedDummyHashPromise = hashPassword(DUMMY_PLAINTEXT, config).catch((err) => {
      // Failure (corrupt config, unavailable argon2 binary) must not
      // pin a rejected promise for the rest of the process — reset
      // so the next login attempt retries the hash computation.
      cachedDummyHashPromise = null;
      throw err;
    });
  }
  return cachedDummyHashPromise;
}

/** Test-only — flush the memoised dummy hash between cases. */
export function resetDummyPasswordHashCacheForTests(): void {
  cachedDummyHashPromise = null;
}
