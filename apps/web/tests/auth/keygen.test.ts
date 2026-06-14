// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  API_KEY_LIVE_PREFIX,
  API_KEY_PATTERN,
  API_KEY_PREFIX_LEN,
  API_KEY_SECRET_HEX_LEN,
  API_KEY_TEST_PREFIX,
  AuthError,
  extractMode,
  extractPrefix,
  generateApiKey,
  parseApiKey,
  safeParseApiKey,
} from '@/lib/auth';

describe('auth/keygen', () => {
  describe('generateApiKey', () => {
    it('produces a syntactically valid live key', () => {
      const k = generateApiKey('live');
      expect(k.full).toMatch(API_KEY_PATTERN);
      expect(k.full.startsWith(API_KEY_LIVE_PREFIX)).toBe(true);
      expect(k.full.length).toBe(API_KEY_LIVE_PREFIX.length + API_KEY_SECRET_HEX_LEN);
      expect(k.prefix.length).toBe(API_KEY_PREFIX_LEN);
      expect(k.prefix).toBe(k.full.slice(0, API_KEY_PREFIX_LEN));
      expect(k.secret.length).toBe(API_KEY_SECRET_HEX_LEN);
      expect(k.mode).toBe('live');
    });

    it('produces a syntactically valid test key', () => {
      const k = generateApiKey('test');
      expect(k.full.startsWith(API_KEY_TEST_PREFIX)).toBe(true);
      expect(k.mode).toBe('test');
    });

    it('produces different keys on successive calls', () => {
      const a = generateApiKey('live');
      const b = generateApiKey('live');
      expect(a.full).not.toBe(b.full);
      expect(a.secret).not.toBe(b.secret);
    });

    it('rejects an unknown mode', () => {
      // @ts-expect-error intentional wrong type
      expect(() => generateApiKey('sandbox')).toThrow(AuthError);
    });
  });

  describe('parseApiKey', () => {
    it('decomposes a well-formed live key', () => {
      const k = generateApiKey('live');
      const parsed = parseApiKey(k.full);
      expect(parsed.full).toBe(k.full);
      expect(parsed.prefix).toBe(k.prefix);
      expect(parsed.secret).toBe(k.secret);
      expect(parsed.mode).toBe('live');
    });

    it('rejects a wrong mode marker', () => {
      expect(() => parseApiKey(`crv_prod_${'a'.repeat(48)}`)).toThrow(AuthError);
    });

    it('rejects a short secret', () => {
      expect(() => parseApiKey(`crv_live_${'a'.repeat(47)}`)).toThrow(AuthError);
    });

    it('rejects a non-hex secret', () => {
      expect(() => parseApiKey(`crv_live_${'g'.repeat(48)}`)).toThrow(AuthError);
    });

    it('rejects uppercase hex', () => {
      expect(() => parseApiKey(`crv_live_${'A'.repeat(48)}`)).toThrow(AuthError);
    });

    it('rejects a non-string input', () => {
      // @ts-expect-error intentional wrong type
      expect(() => parseApiKey(12345)).toThrow(AuthError);
    });
  });

  describe('safeParseApiKey', () => {
    it('returns null on malformed input', () => {
      expect(safeParseApiKey('nope')).toBeNull();
      expect(safeParseApiKey(null)).toBeNull();
      expect(safeParseApiKey(undefined)).toBeNull();
      expect(safeParseApiKey(`crv_live_${'a'.repeat(10)}`)).toBeNull();
    });

    it('returns the parsed object on a valid key', () => {
      const k = generateApiKey('test');
      const p = safeParseApiKey(k.full);
      if (p === null) {
        throw new Error('expected safeParseApiKey to return a parsed key');
      }
      expect(p.mode).toBe('test');
      expect(p.prefix).toBe(k.prefix);
    });
  });

  describe('extractPrefix', () => {
    it('returns the 12-char prefix on a valid key', () => {
      const k = generateApiKey('live');
      expect(extractPrefix(k.full)).toBe(k.prefix);
    });
    it('returns null on too-short input', () => {
      expect(extractPrefix('crv_live')).toBeNull();
    });
    it('returns null on unknown mode prefix', () => {
      expect(extractPrefix(`abc_live_${'a'.repeat(48)}`)).toBeNull();
    });
    it('returns null on non-string input', () => {
      // @ts-expect-error intentional wrong type
      expect(extractPrefix(42)).toBeNull();
    });
  });

  describe('extractMode', () => {
    it('detects live/test', () => {
      expect(extractMode(`crv_live_${'a'.repeat(48)}`)).toBe('live');
      expect(extractMode(`crv_test_${'a'.repeat(48)}`)).toBe('test');
    });
    it('returns null on unknown prefix', () => {
      expect(extractMode(`crv_other_${'a'.repeat(48)}`)).toBeNull();
    });
  });
});
