// @vitest-environment node
/**
 * Authorization code + access token primitive tests.
 *
 * Both primitives follow the same single-use-bearer-token pattern:
 *   - 32 bytes of CSPRNG entropy, base64url encoded on the wire.
 *   - Only the SHA-256 hash lives in the DB.
 *
 * These tests check the shape, uniqueness and hash determinism that
 * the token/code tables depend on.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  generateAuthorizationCode,
  hashAuthorizationCode,
} from '@/lib/oauth/codes';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateAccessToken,
  hashAccessToken,
} from '@/lib/oauth/tokens';

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

describe('oauth/codes — authorization codes', () => {
  it('TTL is 60s (RFC 6749 §4.1.2 recommends ≤ 600s; short is better)', () => {
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBe(60);
  });

  it('generateAuthorizationCode is 43 base64url chars (32 bytes)', () => {
    const code = generateAuthorizationCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates unique codes across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateAuthorizationCode());
    expect(seen.size).toBe(500);
  });

  it('hashAuthorizationCode is deterministic 64-hex SHA-256', () => {
    const code = generateAuthorizationCode();
    const h = hashAuthorizationCode(code);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(code));
    expect(hashAuthorizationCode(code)).toBe(h);
  });

  it('different raw codes hash to different digests', () => {
    const a = hashAuthorizationCode(generateAuthorizationCode());
    const b = hashAuthorizationCode(generateAuthorizationCode());
    expect(a).not.toBe(b);
  });
});

describe('oauth/tokens — access tokens', () => {
  it('TTL is 1 hour (OAuth 2.1 default)', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(60 * 60);
  });

  it('generateAccessToken is 43 base64url chars', () => {
    const token = generateAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates unique tokens across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateAccessToken());
    expect(seen.size).toBe(500);
  });

  it('hashAccessToken is deterministic 64-hex SHA-256', () => {
    const token = generateAccessToken();
    const h = hashAccessToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(token));
  });
});
