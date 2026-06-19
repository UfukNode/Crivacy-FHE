// @vitest-environment node
/**
 * OAuth scope handling tests.
 *
 * Scope plumbing is the most common attack surface in OAuth
 * deployments: an authorize endpoint that silently drops unknown
 * scopes (or treats comma-separated as space-separated) leaks
 * capabilities. Each rule here is enforced at a single call site,
 * and the handler flow depends on this module's contract.
 */

import { describe, expect, it } from 'vitest';

import { OauthError } from '@/lib/oauth/errors';
import {
  assertConsentCovers,
  assertScopeAllowed,
  canonicaliseScope,
  claimsForScopes,
  hashScope,
  isScopeSubset,
  KNOWN_SCOPE_IDS,
  parseScope,
} from '@/lib/oauth/scopes';

describe('oauth/scopes — parseScope', () => {
  it('accepts every canonical scope', () => {
    for (const scope of KNOWN_SCOPE_IDS) {
      const parsed = parseScope(scope);
      // `parseScope` runs `expandImplicitScopes`, which auto-adds
      // `credential` whenever any `kyc*` scope appears. Input-only
      // cases like `openid` are unaffected; the `kyc*` cases gain
      // the Chain reference automatically.
      if (scope.startsWith('kyc')) {
        expect(parsed).toContain(scope);
        expect(parsed).toContain('credential');
      } else {
        expect(parsed).toEqual([scope]);
      }
    }
  });

  it('splits space-separated tokens in input order then dedupes', () => {
    const result = parseScope('openid kyc kyc credential');
    expect(result).toEqual(['openid', 'kyc', 'credential']);
  });

  it('throws invalid_scope on unknown tokens', () => {
    expect(() => parseScope('openid kyc:delete')).toThrow(OauthError);
    expect(() => parseScope('email')).toThrow(OauthError);
  });

  it('throws when the parameter is missing', () => {
    expect(() => parseScope(null)).toThrow(OauthError);
    expect(() => parseScope(undefined)).toThrow(OauthError);
  });

  it('throws when the parameter is empty or whitespace-only', () => {
    expect(() => parseScope('')).toThrow(OauthError);
    expect(() => parseScope('   ')).toThrow(OauthError);
  });

  it('collapses runs of whitespace (OAuth wire is space-separated)', () => {
    // `parseScope` runs `expandImplicitScopes` which auto-bundles
    // `credential` whenever any `kyc*` scope is requested — the
    // Chain reference is part of the zero-trust verification story,
    // so firms never have to remember to ask for it.
    expect(parseScope('openid    kyc\tkyc:scores')).toEqual([
      'openid',
      'kyc',
      'kyc:scores',
      'credential',
    ]);
  });

  it('does NOT accept comma-separated scopes (common misconfig)', () => {
    expect(() => parseScope('openid,kyc')).toThrow(OauthError);
  });
});

describe('oauth/scopes — canonicaliseScope + hashScope', () => {
  it('sorts scopes alphabetically so permutations hash equally', () => {
    const a = canonicaliseScope(parseScope('openid kyc credential'));
    const b = canonicaliseScope(parseScope('credential openid kyc'));
    expect(a).toBe(b);
    expect(hashScope(parseScope('openid kyc'))).toBe(hashScope(parseScope('kyc openid')));
  });

  it('hashScope is 64-char hex SHA-256', () => {
    const h = hashScope(parseScope('openid kyc'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different scope sets hash differently', () => {
    expect(hashScope(parseScope('openid'))).not.toBe(hashScope(parseScope('openid kyc')));
  });
});

describe('oauth/scopes — isScopeSubset', () => {
  it('is true when every requested scope is allowed', () => {
    expect(isScopeSubset(['openid'], ['openid', 'kyc'])).toBe(true);
    expect(isScopeSubset(['openid', 'kyc'], ['openid', 'kyc'])).toBe(true);
  });

  it('is false when the requested set exceeds the allowed set', () => {
    expect(isScopeSubset(['openid', 'credential'], ['openid'])).toBe(false);
  });

  it('is true for the empty requested set', () => {
    // Empty subset of anything is the mathematical empty-subset rule —
    // parseScope refuses empty input earlier, so this branch is a
    // defence-in-depth expectation, not a normal flow.
    expect(isScopeSubset([], ['openid'])).toBe(true);
  });
});

describe('oauth/scopes — assertScopeAllowed', () => {
  it('passes when all requested are in the allowlist', () => {
    expect(() => assertScopeAllowed(['openid', 'kyc'], ['openid', 'kyc', 'credential'])).not.toThrow();
  });

  it('throws invalid_scope listing the extras', () => {
    try {
      assertScopeAllowed(['openid', 'credential'], ['openid']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OauthError);
      expect((err as OauthError).code).toBe('invalid_scope');
      expect((err as OauthError).message).toContain('credential');
    }
  });
});

describe('oauth/scopes — assertConsentCovers', () => {
  it('passes when the cached consent covers the request', () => {
    expect(() => assertConsentCovers(['openid', 'kyc'], ['openid', 'kyc', 'credential'])).not.toThrow();
  });

  it('throws consent_scope_escalation when the request exceeds the cached consent', () => {
    try {
      assertConsentCovers(['openid', 'credential'], ['openid', 'kyc']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OauthError);
      expect((err as OauthError).code).toBe('consent_scope_escalation');
      expect((err as OauthError).message).toContain('credential');
    }
  });
});

describe('oauth/scopes — claimsForScopes', () => {
  it('openid unlocks sub', () => {
    expect(claimsForScopes(['openid'])).toEqual(['sub']);
  });

  it('kyc unlocks identity + liveness', () => {
    expect(claimsForScopes(['kyc'])).toContain('identity_verified');
    expect(claimsForScopes(['kyc'])).toContain('liveness_verified');
  });

  it('credential unlocks chain references', () => {
    const claims = claimsForScopes(['credential']);
    expect(claims).toContain('credential_proof_hash');
    expect(claims).toContain('credential_level');
    expect(claims).toContain('credential_valid_until');
    expect(claims).toContain('credential_network');
  });

  it('deduplicates across multiple scopes (no claim repeated)', () => {
    const claims = claimsForScopes(['openid', 'kyc']);
    expect(new Set(claims).size).toBe(claims.length);
  });
});
