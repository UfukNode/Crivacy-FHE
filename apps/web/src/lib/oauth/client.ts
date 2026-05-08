/**
 * OAuth client credential primitives.
 *
 * `client_id` is a public identifier prefixed so firms can tell at a
 * glance which env they're hitting (`crv_oauth_live_…` vs
 * `crv_oauth_test_…` — mirrors the api-key key prefix convention).
 *
 * `client_secret` is 32 bytes of entropy encoded base64url and
 * hashed with bcrypt before storage. The raw secret is returned to
 * the firm exactly once at create / rotate time and then lives in
 * their backend env vars.
 *
 * Redirect URI validation lives here too so the authorize endpoint
 * has a single source of truth. Exact-match only; wildcard and
 * prefix rules are how every OAuth redirect CVE starts.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { OauthError } from './errors';

/**
 * Client id prefixes. Live vs test lets a firm keep sandbox and
 * production clients side by side without cross-talk, matching the
 * api-key `crv_live_` / `crv_test_` split.
 */
export const CLIENT_ID_LIVE_PREFIX = 'crv_oauth_live_';
export const CLIENT_ID_TEST_PREFIX = 'crv_oauth_test_';
export const CLIENT_ID_BODY_LENGTH = 24;

export type ClientMode = 'live' | 'test';

const PREFIX_MAP: Record<ClientMode, string> = {
  live: CLIENT_ID_LIVE_PREFIX,
  test: CLIENT_ID_TEST_PREFIX,
};

/**
 * Generate a fresh `client_id`. 24 chars of URL-safe base64 after
 * the prefix — 144 bits of entropy, plenty to make collisions
 * unbelievable at any plausible firm count.
 */
export function generateClientId(mode: ClientMode): string {
  const body = randomBytes(18).toString('base64url').slice(0, CLIENT_ID_BODY_LENGTH);
  return `${PREFIX_MAP[mode]}${body}`;
}

/**
 * Generate a fresh client secret — 32 bytes of entropy, base64url.
 * Not prefixed; the secret's namespace is its sibling `client_id`.
 */
export function generateClientSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a client secret for storage. We use argon2id (the same
 * password-hash algorithm used for firm/admin user passwords) rather
 * than bcrypt because secret rotation is rare enough that the
 * higher cost doesn't matter, and it keeps our hash story uniform.
 */
export async function hashClientSecret(raw: string): Promise<string> {
  return argonHash(raw);
}

/** Constant-time compare against a stored argon2id hash. */
export async function verifyClientSecret(raw: string, stored: string): Promise<boolean> {
  try {
    return await argonVerify(stored, raw);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redirect URI validation
// ---------------------------------------------------------------------------

/**
 * Check an inbound `redirect_uri` against the client's whitelist.
 * Exact match required — wildcards, prefix matches, and path-param
 * expansions are all refused. Every OAuth redirect hijack CVE
 * starts with relaxing this rule.
 *
 * Also rejects common foot-guns even before we look at the list:
 *   - Fragment identifiers (`#`) are not allowed in redirect_uris.
 *   - URLs with credentials / IPv6 hosts / invalid schemes are
 *     refused up front so they never reach the whitelist compare.
 *
 * Localhost is allowed on any port so the firm's dev environment
 * works without registering every port.
 */
export function validateRedirectUri(
  requested: string,
  whitelist: readonly string[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(requested);
  } catch {
    return { ok: false, reason: 'redirect_uri is not a valid URL.' };
  }
  if (parsed.hash.length > 0) {
    return { ok: false, reason: 'redirect_uri must not contain a fragment.' };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: 'redirect_uri must not carry userinfo.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      reason: `redirect_uri must use http(s) (got ${parsed.protocol}).`,
    };
  }
  // Allow http only for localhost-family hosts — matches the OAuth
  // 2.1 §8.1 exception for native + development clients.
  // Audit-mode dev exception: when CRIVACY_AUDIT_LOCAL_HTTP=true,
  // also allow http on RFC 1918 private LAN IPs (10/8, 172.16/12,
  // 192.168/16). Mirrors lib/env/app-url.ts:84 so a phone on the same
  // wifi can reach the dev server through the handoff QR flow without
  // TLS termination. Real production never sets this flag.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    const auditLocalHttp = process.env['CRIVACY_AUDIT_LOCAL_HTTP'] === 'true';
    const isPrivateLan = /^(10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(parsed.hostname);
    if (!(auditLocalHttp && isPrivateLan)) {
      return {
        ok: false,
        reason: 'redirect_uri must use https except for loopback addresses.',
      };
    }
  }

  // Exact-match whitelist. `URL` canonicalisation (trailing slash,
  // default port) is applied to both sides so semantically-equal
  // URLs compare equal.
  const canonRequested = canonicaliseUri(parsed);
  for (const candidate of whitelist) {
    try {
      const candidateCanon = canonicaliseUri(new URL(candidate));
      if (candidateCanon === canonRequested) return { ok: true };
    } catch {
      // Malformed entry in DB — log at caller, keep iterating.
      continue;
    }
  }
  return { ok: false, reason: 'redirect_uri is not registered for this client.' };
}

function canonicaliseUri(url: URL): string {
  const cloned = new URL(url.toString());
  cloned.hash = '';
  // Drop default ports so `https://foo.com` and `https://foo.com:443`
  // compare equal.
  if (
    (cloned.protocol === 'https:' && cloned.port === '443') ||
    (cloned.protocol === 'http:' && cloned.port === '80')
  ) {
    cloned.port = '';
  }
  // Leave query string as-is; firms sometimes put static params on
  // their callback (`?mode=verify`) and expect byte-for-byte match.
  return cloned.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function throwRedirectUriMismatch(reason: string): never {
  throw new OauthError('redirect_uri_mismatch', `redirect_uri rejected: ${reason}`);
}
