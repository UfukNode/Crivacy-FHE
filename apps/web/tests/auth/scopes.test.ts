// @vitest-environment node
import type { ApiKeyScope } from '@crivacy/shared-types';
import { describe, expect, it } from 'vitest';

import {
  ALL_SCOPES,
  AuthError,
  hasRequiredScopes,
  intersectScopes,
  isValidScope,
  parseScopes,
  subtractScopes,
} from '@/lib/auth';

describe('auth/scopes', () => {
  it('ALL_SCOPES matches the ApiKeyScope union', () => {
    // Literal round-trip: must remain in lock step with shared-types.
    const expected: readonly ApiKeyScope[] = [
      'kyc:create',
      'kyc:read',
      'kyc:verify',
      'webhooks:manage',
      'usage:read',
    ];
    expect([...ALL_SCOPES]).toEqual(expected);
  });

  describe('isValidScope', () => {
    it('accepts every canonical scope', () => {
      for (const s of ALL_SCOPES) expect(isValidScope(s)).toBe(true);
    });
    it('rejects unknown strings', () => {
      expect(isValidScope('kyc:delete')).toBe(false);
      expect(isValidScope('')).toBe(false);
      expect(isValidScope(null)).toBe(false);
    });
  });

  describe('parseScopes', () => {
    it('returns a deduplicated, canonically ordered list', () => {
      const result = parseScopes(['usage:read', 'kyc:read', 'kyc:read', 'kyc:create']);
      expect(result).toEqual(['kyc:create', 'kyc:read', 'usage:read']);
    });
    it('throws on unknown scopes', () => {
      expect(() => parseScopes(['kyc:read', 'kyc:delete'])).toThrow(AuthError);
    });
    it('returns an empty list on empty input', () => {
      expect(parseScopes([])).toEqual([]);
    });
  });

  describe('hasRequiredScopes', () => {
    it('returns true when required is empty', () => {
      expect(hasRequiredScopes([], [])).toBe(true);
      expect(hasRequiredScopes(['kyc:read'], [])).toBe(true);
    });
    it('returns true on exact match', () => {
      expect(hasRequiredScopes(['kyc:read'], ['kyc:read'])).toBe(true);
    });
    it('returns true on superset match', () => {
      expect(hasRequiredScopes(['kyc:read', 'kyc:create'], ['kyc:read'])).toBe(true);
    });
    it('returns false on missing scope', () => {
      expect(hasRequiredScopes(['kyc:read'], ['kyc:create'])).toBe(false);
    });
    it('returns false on empty actual with non-empty required', () => {
      expect(hasRequiredScopes([], ['kyc:read'])).toBe(false);
    });
  });

  describe('intersectScopes', () => {
    it('returns the overlap in canonical order', () => {
      expect(intersectScopes(['kyc:read', 'kyc:create'], ['kyc:read', 'usage:read'])).toEqual([
        'kyc:read',
      ]);
    });
    it('returns empty when disjoint', () => {
      expect(intersectScopes(['kyc:read'], ['usage:read'])).toEqual([]);
    });
    it('is order-independent', () => {
      const a = intersectScopes(['kyc:create', 'usage:read'], ['kyc:create']);
      const b = intersectScopes(['kyc:create'], ['kyc:create', 'usage:read']);
      expect(a).toEqual(b);
    });
  });

  describe('subtractScopes', () => {
    it('returns scopes in a not in b', () => {
      expect(subtractScopes(['kyc:read', 'kyc:create', 'usage:read'], ['kyc:create'])).toEqual([
        'kyc:read',
        'usage:read',
      ]);
    });
    it('returns empty when a is a subset of b', () => {
      expect(subtractScopes(['kyc:read'], ['kyc:read', 'kyc:create'])).toEqual([]);
    });
  });
});
