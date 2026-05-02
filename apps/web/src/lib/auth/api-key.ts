/**
 * API key hashing + verification.
 *
 * The storage flow:
 *
 *   1. `keygen.generateApiKey()` produces the human-visible `full` key
 *      plus its `prefix`.
 *   2. `hashApiKey(full, config)` returns a bcrypt string plus the
 *      `(algorithm, parameters)` tuple we persist alongside it.
 *   3. At auth time the route looks up a row by `prefix`, reads the
 *      stored `hash`, `hash_algorithm`, `hash_parameters`, and calls
 *      `verifyStoredApiKey()`.
 *
 * bcrypt is fine for short, high-entropy API keys (they are not
 * guessable passwords). Cost 12 is the default for live use; tests use
 * cost 4 by passing `{ cost: 4 }` so the full suite stays fast.
 *
 * The helper is algorithm-aware through `hashAlgorithm`: the row
 * column names exactly match `api_keys.hash_algorithm` /
 * `api_keys.hash_parameters`, so we can migrate to argon2id later by
 * teaching this file to branch on the stored algorithm value without a
 * destructive data migration.
 */

import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';

import type { AuthConfig } from './config';
import { AuthError } from './errors';
import { type ParsedApiKey, parseApiKey } from './keygen';

/* ---------- Types ---------- */

/** Hash algorithm identifier stored in `api_keys.hash_algorithm`. */
export type ApiKeyHashAlgorithm = 'bcrypt';

export interface HashedApiKey {
  readonly hash: string;
  readonly algorithm: ApiKeyHashAlgorithm;
  readonly parameters: string;
}

export interface HashApiKeyOptions {
  /** Override the bcrypt cost for this single call. */
  readonly cost?: number;
}

export interface StoredApiKeyHash {
  readonly hash: string;
  readonly algorithm: string;
  readonly parameters: string;
}

/* ---------- Hashing ---------- */

/**
 * Produce the bcrypt hash for a raw key string. The full key (not just
 * the secret portion) is used as the bcrypt input so that a row whose
 * prefix was observed but hash was not cannot be forged by anyone who
 * also knows the hex alphabet.
 *
 * Cost is taken from `config.apiKeyBcryptCost` unless `opts.cost`
 * overrides it. The returned `parameters` string is the exact value
 * persisted to `api_keys.hash_parameters` and is what
 * `verifyStoredApiKey()` parses on read.
 */
export async function hashApiKey(
  rawKey: string,
  config: Pick<AuthConfig, 'apiKeyBcryptCost'>,
  opts: HashApiKeyOptions = {},
): Promise<HashedApiKey> {
  // Validate shape before spending CPU on a bcrypt round.
  parseApiKey(rawKey);
  const cost = opts.cost ?? config.apiKeyBcryptCost;
  assertCost(cost);
  const hashed = await bcryptHash(rawKey, cost);
  return {
    hash: hashed,
    algorithm: 'bcrypt',
    parameters: `cost=${cost}`,
  };
}

/* ---------- Verification ---------- */

/**
 * Shape of a well-formed bcrypt hash string:
 *
 *     $2[aby]$CC$<22-char b64 salt><31-char b64 hash>
 *
 * Total length is always 60. `@node-rs/bcrypt`'s `verify()` silently
 * returns `false` on strings it cannot parse, so we pre-check the
 * format ourselves and promote a bad row to `AuthError` before the
 * native call ever sees it. This keeps a corrupt DB row distinguishable
 * from a wrong key at the type level.
 */
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function assertBcryptHashShape(hash: string): void {
  if (typeof hash !== 'string' || !BCRYPT_HASH_PATTERN.test(hash)) {
    throw new AuthError('unsupported_api_key_hash', 'stored bcrypt hash failed to parse');
  }
}

/**
 * Compare a raw key against a stored `(hash, algorithm, parameters)`
 * tuple. Returns `true` only on a clean match; any structural problem
 * with the stored fields throws `AuthError` so the caller cannot
 * accidentally treat "bad row" as "wrong password".
 */
export async function verifyStoredApiKey(
  rawKey: string,
  stored: StoredApiKeyHash,
): Promise<boolean> {
  if (stored.algorithm !== 'bcrypt') {
    throw new AuthError(
      'unsupported_api_key_hash',
      `unknown api key hash algorithm: ${stored.algorithm}`,
    );
  }
  assertBcryptHashShape(stored.hash);
  // Intentionally NOT calling parseApiKey here: a malformed input must
  // not cause a throw during the hot path auth check; it's a plain
  // verification failure.
  try {
    return await bcryptVerify(rawKey, stored.hash);
  } catch (cause) {
    // Defense in depth: if the native binding ever *does* throw on a
    // shape-valid-but-semantically-bad hash, promote to AuthError so
    // ops alerts trigger instead of the user seeing a mystery 401.
    throw new AuthError('unsupported_api_key_hash', 'stored bcrypt hash failed to parse', {
      cause,
    });
  }
}

/**
 * Convenience wrapper: verify a raw key by computing its hash directly
 * (only useful for unit tests that want to skip the parameters layer).
 */
export async function verifyApiKey(rawKey: string, hash: string): Promise<boolean> {
  assertBcryptHashShape(hash);
  try {
    return await bcryptVerify(rawKey, hash);
  } catch (cause) {
    throw new AuthError('unsupported_api_key_hash', 'stored bcrypt hash failed to parse', {
      cause,
    });
  }
}

/**
 * Parse `hash_parameters` back into a cost integer. Exposed so
 * dashboard and audit-log rendering can show the cost factor without
 * re-implementing the string split.
 */
export function parseStoredBcryptCost(parameters: string): number {
  const match = /^cost=(\d{1,2})$/.exec(parameters);
  if (!match) {
    throw new AuthError(
      'unsupported_api_key_hash',
      `unrecognised bcrypt parameters string: ${parameters}`,
    );
  }
  const [, rawCost] = match;
  if (rawCost === undefined) {
    throw new AuthError(
      'unsupported_api_key_hash',
      `bcrypt parameters string did not capture a cost: ${parameters}`,
    );
  }
  const cost = Number.parseInt(rawCost, 10);
  assertCost(cost);
  return cost;
}

/**
 * Return true when the stored row was hashed at a cost strictly below
 * `config.apiKeyBcryptCost`. The caller (rotation job) uses this to
 * re-hash keys lazily on next successful verify so old rows pick up
 * new cost settings without a blocking migration.
 */
export function needsRehash(
  stored: StoredApiKeyHash,
  config: Pick<AuthConfig, 'apiKeyBcryptCost'>,
): boolean {
  if (stored.algorithm !== 'bcrypt') {
    return true;
  }
  const cost = parseStoredBcryptCost(stored.parameters);
  return cost < config.apiKeyBcryptCost;
}

/* ---------- Convenience ---------- */

/**
 * Parse + hash + return the full record to insert into `api_keys`.
 * Callers use this as a one-liner in the provisioning path.
 */
export async function buildApiKeyInsert(
  parsed: ParsedApiKey,
  config: Pick<AuthConfig, 'apiKeyBcryptCost'>,
  opts: HashApiKeyOptions = {},
): Promise<HashedApiKey & { prefix: string }> {
  const hashed = await hashApiKey(parsed.full, config, opts);
  return { ...hashed, prefix: parsed.prefix };
}

/* ---------- Private ---------- */

function assertCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 4 || cost > 15) {
    throw new AuthError(
      'unsupported_api_key_hash',
      `bcrypt cost must be an integer in [4, 15]; got ${cost}`,
    );
  }
}
