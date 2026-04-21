/**
 * PKCE helpers using the Web Crypto API (RFC 7636).
 *
 * Works in any environment that exposes `crypto.subtle` — modern
 * browsers, Deno, Bun, and Node.js ≥18. Falls back to the Node
 * `node:crypto` module when `crypto.subtle` is missing (older Node
 * LTS + specific serverless runtimes) so the same SDK can power a
 * firm's backend code-exchange helper too.
 *
 * @module
 */

import { CrivacyOauthError } from './errors';

/** RFC 7636 §4.1 — verifier is 43-128 chars of the unreserved URI set. */
const VERIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export type CodeChallengeMethod = 'S256';

/**
 * Generate a cryptographically random `code_verifier`. Default 64
 * chars — comfortably in the 43–128 RFC range and long enough that
 * a brute-force attempt is implausible.
 */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new CrivacyOauthError(
      'pkce_invalid',
      `code_verifier length must be 43-128 (got ${length}).`,
    );
  }
  const bytes = new Uint8Array(length);
  const cryptoSource = resolveCrypto();
  cryptoSource.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += VERIFIER_CHARSET[bytes[i]! % VERIFIER_CHARSET.length];
  }
  return out;
}

/**
 * Compute the S256 `code_challenge` = base64url(SHA-256(verifier)).
 * Matches the server's `computeCodeChallenge` output byte-for-byte.
 */
export async function computeCodeChallenge(
  verifier: string,
  method: CodeChallengeMethod = 'S256',
): Promise<string> {
  if (method !== 'S256') {
    throw new CrivacyOauthError('pkce_invalid', `Unsupported method: ${method}`);
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await sha256(data);
  return base64UrlEncode(digest);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const cryptoSource = resolveCrypto();
  if (typeof cryptoSource.subtle !== 'undefined') {
    // Copy into a fresh ArrayBuffer so the Web Crypto API sees an
    // ArrayBuffer-backed view rather than a SharedArrayBuffer or
    // other exotic backing store.
    const copy = new Uint8Array(data);
    const digest = await cryptoSource.subtle.digest('SHA-256', copy.buffer);
    return new Uint8Array(digest);
  }
  // Node fallback for runtimes without subtle (older Node, edge
  // runtime variants). Lazy-import so browser bundlers don't pull
  // in the Node shim.
  type NodeCrypto = { createHash(alg: string): { update(data: Uint8Array): { digest(): Uint8Array } } };
  const { createHash } = (await import('node:crypto')) as unknown as NodeCrypto;
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function resolveCrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto !== null) {
    return globalThis.crypto;
  }
  throw new CrivacyOauthError(
    'pkce_invalid',
    'No Web Crypto implementation found. Upgrade to Node.js ≥18 or run in a modern browser.',
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a random opaque `state` value suitable for CSRF
 * protection. 32 bytes → 43 base64url chars. Not a secret; it only
 * needs to be unpredictable-enough that an attacker can't forge a
 * matching value in a CSRF flow.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  resolveCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Generate an OIDC `nonce`. Same shape as state; separate function
 * so consumers that want both can keep them distinct.
 */
export function generateNonce(): string {
  return generateState();
}
