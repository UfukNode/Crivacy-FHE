/**
 * API key string format + generation.
 *
 * Keys follow the convention popularized by Stripe:
 *
 *     crv_<mode>_<48 hex chars>
 *
 * where `mode` is `live` or `test`. The 48-char secret is derived from
 * 24 random bytes (192 bits of entropy — comfortable for a bcrypt input
 * that must stay under bcrypt's 72-byte hard limit).
 *
 * The `prefix` stored in `api_keys.prefix` is the first 12 characters
 * of the full key (`crv_live_XXX` or `crv_test_XXX`, so 9 fixed + 3
 * secret chars). Prefix lookups are O(1) because of the unique index,
 * and the bcrypt comparison in `api-key.ts` authoritatively decides
 * whether the hash matches.
 *
 * Full contract:
 *
 *     generateApiKey('live')  ->  {
 *         full:    'crv_live_0123456789abcdef...abcd'   (57 chars)
 *         prefix:  'crv_live_012'                        (12 chars)
 *         secret:  '0123456789abcdef...abcd'             (48 chars, hex)
 *         mode:    'live'
 *     }
 *
 *     parseApiKey('crv_test_...')  ->  { mode, prefix, secret }
 *
 * Only the `full` value is ever shown to users (dashboard, API
 * response). It is never stored as-is; only `prefix` and `bcrypt(full)`
 * are persisted.
 */

import { randomBytes } from 'node:crypto';

import type { ApiKeyMode } from '@crivacy/shared-types';

import { AuthError } from './errors';

/* ---------- Constants ---------- */

/** 24 random bytes -> 48 hex chars. */
export const API_KEY_SECRET_BYTES = 24;
export const API_KEY_SECRET_HEX_LEN = API_KEY_SECRET_BYTES * 2; // 48
export const API_KEY_PREFIX_LEN = 12;
export const API_KEY_LIVE_PREFIX = 'crv_live_';
export const API_KEY_TEST_PREFIX = 'crv_test_';

const MODE_PREFIX: Record<ApiKeyMode, string> = {
  live: API_KEY_LIVE_PREFIX,
  test: API_KEY_TEST_PREFIX,
};

/** Matches `crv_(live|test)_<48 lowercase hex>`. */
export const API_KEY_PATTERN = /^crv_(live|test)_([0-9a-f]{48})$/;

/* ---------- Types ---------- */

export interface GeneratedApiKey {
  readonly full: string;
  readonly prefix: string;
  readonly secret: string;
  readonly mode: ApiKeyMode;
}

export interface ParsedApiKey {
  readonly full: string;
  readonly prefix: string;
  readonly secret: string;
  readonly mode: ApiKeyMode;
}

/* ---------- Generation ---------- */

/**
 * Produce a fresh key using `crypto.randomBytes`. The mode drives the
 * visible prefix and is echoed back in the result for the caller to
 * insert into `api_keys.mode`.
 */
export function generateApiKey(mode: ApiKeyMode): GeneratedApiKey {
  const modePrefix = MODE_PREFIX[mode];
  if (modePrefix === undefined) {
    throw new AuthError('invalid_api_key', `unknown api key mode: ${String(mode)}`);
  }
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString('hex');
  const full = modePrefix + secret;
  const prefix = full.slice(0, API_KEY_PREFIX_LEN);
  return { full, prefix, secret, mode };
}

/* ---------- Parsing ---------- */

/**
 * Decompose a raw key string into its parts. Returns a discriminated
 * `ParsedApiKey`; throws `AuthError('invalid_api_key')` on any
 * structural problem. Use `safeParseApiKey()` for a non-throwing
 * variant.
 */
export function parseApiKey(raw: string): ParsedApiKey {
  if (typeof raw !== 'string') {
    throw new AuthError('invalid_api_key', 'api key must be a string');
  }
  const match = API_KEY_PATTERN.exec(raw);
  if (!match) {
    throw new AuthError(
      'invalid_api_key',
      'api key does not match the expected format `crv_(live|test)_<48 hex>`',
    );
  }
  const [, rawMode, secret] = match;
  if (rawMode === undefined || secret === undefined) {
    // Unreachable: the regex guarantees both capture groups, but the
    // type narrowing here keeps strict mode and lint happy.
    throw new AuthError('invalid_api_key', 'api key regex produced an incomplete match');
  }
  return {
    full: raw,
    prefix: raw.slice(0, API_KEY_PREFIX_LEN),
    secret,
    mode: rawMode as ApiKeyMode,
  };
}

/**
 * Non-throwing variant of `parseApiKey`. Returns `null` instead of
 * raising — useful at the middleware boundary where a malformed
 * `Authorization` header should become a 401 without unwinding the
 * stack.
 */
export function safeParseApiKey(raw: unknown): ParsedApiKey | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = API_KEY_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const [, rawMode, secret] = match;
  if (rawMode === undefined || secret === undefined) {
    return null;
  }
  return {
    full: raw,
    prefix: raw.slice(0, API_KEY_PREFIX_LEN),
    secret,
    mode: rawMode as ApiKeyMode,
  };
}

/**
 * Pure string operation: extract only the prefix column we need for
 * the DB lookup, without running the full validator. The rest of the
 * key is verified later by the bcrypt compare.
 *
 * Returns `null` if the raw value is too short or does not start with
 * a recognised mode prefix.
 */
export function extractPrefix(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length < API_KEY_PREFIX_LEN) {
    return null;
  }
  if (!raw.startsWith(API_KEY_LIVE_PREFIX) && !raw.startsWith(API_KEY_TEST_PREFIX)) {
    return null;
  }
  return raw.slice(0, API_KEY_PREFIX_LEN);
}

/**
 * Return the mode byte without running the full regex. Useful for
 * metrics (`auth.apikey.live` vs `auth.apikey.test`) where we want to
 * tag the label before spending time on the hash compare.
 */
export function extractMode(raw: string): ApiKeyMode | null {
  if (raw.startsWith(API_KEY_LIVE_PREFIX)) return 'live';
  if (raw.startsWith(API_KEY_TEST_PREFIX)) return 'test';
  return null;
}
