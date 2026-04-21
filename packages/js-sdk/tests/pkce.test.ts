// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CrivacyOauthError } from '../src/errors';
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from '../src/pkce';

function referenceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('pkce — generateCodeVerifier', () => {
  it('returns a string in the unreserved URI set with the requested length', () => {
    const v = generateCodeVerifier(64);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
  });

  it('rejects out-of-range lengths', () => {
    expect(() => generateCodeVerifier(42)).toThrow(CrivacyOauthError);
    expect(() => generateCodeVerifier(129)).toThrow(CrivacyOauthError);
  });

  it('yields unique values across invocations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(generateCodeVerifier());
    expect(seen.size).toBe(100);
  });
});

describe('pkce — computeCodeChallenge', () => {
  it('matches the RFC 7636 reference digest', async () => {
    expect(
      await computeCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('matches the Node node:crypto reference implementation', async () => {
    for (let i = 0; i < 10; i += 1) {
      const v = generateCodeVerifier(64);
      expect(await computeCodeChallenge(v)).toBe(referenceChallenge(v));
    }
  });

  it('rejects non-S256 methods', async () => {
    await expect(
      computeCodeChallenge('a'.repeat(64), 'plain' as never),
    ).rejects.toThrow(CrivacyOauthError);
  });
});

describe('pkce — generateState / generateNonce', () => {
  it('produces 43-char base64url values', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
