// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  apiKeyNeedsRehash,
  buildApiKeyInsert,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  parseStoredBcryptCost,
  verifyApiKey,
  verifyStoredApiKey,
} from '@/lib/auth';

import { buildTestConfig } from './fixtures';

const CONFIG = buildTestConfig();

describe('auth/api-key', () => {
  describe('hashApiKey', () => {
    it('returns a bcrypt hash and the recorded parameters', async () => {
      const raw = generateApiKey('live');
      const result = await hashApiKey(raw.full, CONFIG);
      expect(result.algorithm).toBe('bcrypt');
      expect(result.parameters).toBe(`cost=${CONFIG.apiKeyBcryptCost}`);
      expect(result.hash).toMatch(/^\$2[aby]\$04\$/); // cost=4 prefix
    });

    it('respects an explicit cost override', async () => {
      const raw = generateApiKey('test');
      const result = await hashApiKey(raw.full, CONFIG, { cost: 5 });
      expect(result.parameters).toBe('cost=5');
      expect(result.hash).toMatch(/^\$2[aby]\$05\$/);
    });

    it('rejects a malformed raw key before spending CPU', async () => {
      await expect(hashApiKey('not-a-key', CONFIG)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects an out-of-range cost', async () => {
      const raw = generateApiKey('live');
      await expect(hashApiKey(raw.full, CONFIG, { cost: 2 })).rejects.toBeInstanceOf(AuthError);
      await expect(hashApiKey(raw.full, CONFIG, { cost: 20 })).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('verifyStoredApiKey', () => {
    it('accepts a matching key', async () => {
      const raw = generateApiKey('live');
      const hashed = await hashApiKey(raw.full, CONFIG);
      const ok = await verifyStoredApiKey(raw.full, hashed);
      expect(ok).toBe(true);
    });

    it('rejects a wrong key', async () => {
      const a = generateApiKey('live');
      const b = generateApiKey('live');
      const hashed = await hashApiKey(a.full, CONFIG);
      const ok = await verifyStoredApiKey(b.full, hashed);
      expect(ok).toBe(false);
    });

    it('rejects when the stored algorithm is unknown', async () => {
      const raw = generateApiKey('live');
      const hashed = await hashApiKey(raw.full, CONFIG);
      await expect(
        verifyStoredApiKey(raw.full, { ...hashed, algorithm: 'argon2id' }),
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('promotes a corrupt stored hash to an AuthError', async () => {
      await expect(
        verifyStoredApiKey(`crv_live_${'a'.repeat(48)}`, {
          algorithm: 'bcrypt',
          parameters: 'cost=12',
          hash: 'not-a-bcrypt-string',
        }),
      ).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('verifyApiKey (raw hash)', () => {
    it('matches the bcrypt hash directly', async () => {
      const raw = generateApiKey('live');
      const { hash } = await hashApiKey(raw.full, CONFIG);
      expect(await verifyApiKey(raw.full, hash)).toBe(true);
    });

    it('returns false for a mismatch', async () => {
      const raw = generateApiKey('live');
      const { hash } = await hashApiKey(raw.full, CONFIG);
      expect(await verifyApiKey(`crv_live_${'b'.repeat(48)}`, hash)).toBe(false);
    });
  });

  describe('parseStoredBcryptCost', () => {
    it('extracts the cost integer', () => {
      expect(parseStoredBcryptCost('cost=12')).toBe(12);
      expect(parseStoredBcryptCost('cost=4')).toBe(4);
    });
    it('throws on malformed input', () => {
      expect(() => parseStoredBcryptCost('rounds=12')).toThrow(AuthError);
      expect(() => parseStoredBcryptCost('cost=')).toThrow(AuthError);
      expect(() => parseStoredBcryptCost('cost=foo')).toThrow(AuthError);
    });
    it('throws on out-of-range cost', () => {
      expect(() => parseStoredBcryptCost('cost=3')).toThrow(AuthError);
      expect(() => parseStoredBcryptCost('cost=20')).toThrow(AuthError);
    });
  });

  describe('apiKeyNeedsRehash', () => {
    it('returns false when the stored cost matches current config', async () => {
      const raw = generateApiKey('live');
      const hashed = await hashApiKey(raw.full, CONFIG);
      expect(apiKeyNeedsRehash(hashed, CONFIG)).toBe(false);
    });
    it('returns true when the stored cost is lower than the current config', async () => {
      const raw = generateApiKey('live');
      const hashed = await hashApiKey(raw.full, CONFIG, { cost: 4 });
      expect(apiKeyNeedsRehash(hashed, { apiKeyBcryptCost: 12 })).toBe(true);
    });
    it('returns true for an unknown algorithm', () => {
      expect(
        apiKeyNeedsRehash({ hash: 'whatever', algorithm: 'argon2id', parameters: 'm=64' }, CONFIG),
      ).toBe(true);
    });
  });

  describe('buildApiKeyInsert', () => {
    it('produces a row-ready record', async () => {
      const raw = generateApiKey('test');
      const parsed = parseApiKey(raw.full);
      const row = await buildApiKeyInsert(parsed, CONFIG);
      expect(row.algorithm).toBe('bcrypt');
      expect(row.prefix).toBe(parsed.prefix);
      expect(row.hash).toMatch(/^\$2/);
      expect(row.parameters).toBe(`cost=${CONFIG.apiKeyBcryptCost}`);
    });
  });
});
