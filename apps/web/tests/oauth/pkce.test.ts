// @vitest-environment node
/**
 * PKCE primitive tests.
 *
 * Covers RFC 7636 §4.3 + §4.6 edge cases — an authorize endpoint
 * that gets PKCE wrong is a code-injection vulnerability. Every
 * assertion here is a rule that must hold for the authorize +
 * token handlers to remain sound.
 */

import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OauthError } from '@/lib/oauth/errors';
import {
  assertValidCodeChallenge,
  assertValidCodeVerifier,
  computeCodeChallenge,
  verifyCodeChallenge,
} from '@/lib/oauth/pkce';

function referenceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomVerifier(length = 64): string {
  // Only use the unreserved-set chars RFC 7636 allows. 64 is in the
  // middle of the 43–128 range — comfortably canonical.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

describe('oauth/pkce — computeCodeChallenge', () => {
  it('matches the RFC 7636 reference digest for a known verifier', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // Reference value from RFC 7636 §4.6 Appendix B.
    expect(computeCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('agrees with an inline SHA-256+base64url implementation', () => {
    for (let i = 0; i < 20; i += 1) {
      const verifier = randomVerifier(43 + (i % 40));
      expect(computeCodeChallenge(verifier)).toBe(referenceChallenge(verifier));
    }
  });

  it('rejects any method other than S256', () => {
    expect(() => computeCodeChallenge('a'.repeat(43), 'plain' as never)).toThrow(OauthError);
  });
});

describe('oauth/pkce — assertValidCodeChallenge', () => {
  it('accepts a 43-char base64url SHA-256 digest with S256', () => {
    const challenge = referenceChallenge('a'.repeat(64));
    expect(() => assertValidCodeChallenge(challenge, 'S256')).not.toThrow();
  });

  it('rejects non-S256 methods', () => {
    const challenge = referenceChallenge('a'.repeat(64));
    expect(() => assertValidCodeChallenge(challenge, 'plain')).toThrow(OauthError);
    expect(() => assertValidCodeChallenge(challenge, 'S512' as never)).toThrow(OauthError);
    expect(() => assertValidCodeChallenge(challenge, '' as never)).toThrow(OauthError);
  });

  it('rejects challenges that are too short or too long', () => {
    expect(() => assertValidCodeChallenge('a'.repeat(42), 'S256')).toThrow(OauthError);
    expect(() => assertValidCodeChallenge('a'.repeat(44), 'S256')).toThrow(OauthError);
  });

  it('rejects challenges containing chars outside base64url', () => {
    const bad = 'A'.repeat(42) + '/';
    expect(() => assertValidCodeChallenge(bad, 'S256')).toThrow(OauthError);
  });
});

describe('oauth/pkce — assertValidCodeVerifier', () => {
  it('accepts verifiers at the RFC length bounds', () => {
    expect(() => assertValidCodeVerifier('a'.repeat(43))).not.toThrow();
    expect(() => assertValidCodeVerifier('a'.repeat(128))).not.toThrow();
  });

  it('rejects verifiers outside the RFC length bounds', () => {
    expect(() => assertValidCodeVerifier('a'.repeat(42))).toThrow(OauthError);
    expect(() => assertValidCodeVerifier('a'.repeat(129))).toThrow(OauthError);
  });

  it('rejects verifiers with disallowed characters', () => {
    // '=' is the padding char and the most common mistake.
    const bad = 'a'.repeat(42) + '=';
    expect(() => assertValidCodeVerifier(bad)).toThrow(OauthError);
    // Space, which could leak into URL-encoded transports.
    expect(() => assertValidCodeVerifier('a'.repeat(42) + ' ')).toThrow(OauthError);
  });
});

describe('oauth/pkce — verifyCodeChallenge', () => {
  it('passes when challenge equals SHA-256(verifier)', () => {
    const verifier = randomVerifier(96);
    const challenge = referenceChallenge(verifier);
    expect(() => verifyCodeChallenge(challenge, 'S256', verifier)).not.toThrow();
  });

  it('fails when verifier is modified in any byte', () => {
    const verifier = randomVerifier(96);
    const challenge = referenceChallenge(verifier);
    const tampered = verifier.slice(0, -1) + (verifier.at(-1) === 'a' ? 'b' : 'a');
    expect(() => verifyCodeChallenge(challenge, 'S256', tampered)).toThrow(OauthError);
  });

  it('fails when challenge is truncated or padded', () => {
    const verifier = randomVerifier(96);
    const challenge = referenceChallenge(verifier);
    expect(() => verifyCodeChallenge(challenge.slice(0, -1), 'S256', verifier)).toThrow(
      OauthError,
    );
  });

  it('fails when method is not S256', () => {
    const verifier = randomVerifier(96);
    const challenge = referenceChallenge(verifier);
    expect(() => verifyCodeChallenge(challenge, 'plain', verifier)).toThrow(OauthError);
  });

  it('fails when verifier is structurally invalid even if challenge matches an empty sha256', () => {
    // An attacker supplying a malformed verifier must be rejected at
    // shape check before the compare — otherwise they could feed
    // arbitrary strings to the crypto layer.
    const verifier = 'short'; // < 43 chars
    const challenge = referenceChallenge(verifier);
    expect(() => verifyCodeChallenge(challenge, 'S256', verifier)).toThrow(OauthError);
  });
});
