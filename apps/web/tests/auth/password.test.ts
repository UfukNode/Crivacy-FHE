// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  hashPassword,
  parseArgon2Header,
  passwordNeedsRehash,
  verifyPassword,
} from '@/lib/auth';

import { buildTestConfig } from './fixtures';

const CONFIG = buildTestConfig();

const GOOD_PASSWORD = 'correct horse battery staple';

describe('auth/password', () => {
  describe('hashPassword', () => {
    it('produces an argon2id string', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      expect(hash.startsWith('$argon2id$')).toBe(true);
    });

    it('embeds the configured parameters', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      const parsed = parseArgon2Header(hash);
      expect(parsed.algorithm).toBe('argon2id');
      expect(parsed.memoryCost).toBe(CONFIG.passwordArgon2MemoryKib);
      expect(parsed.timeCost).toBe(CONFIG.passwordArgon2Iterations);
      expect(parsed.parallelism).toBe(CONFIG.passwordArgon2Parallelism);
    });

    it('respects explicit overrides', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG, {
        memoryCost: 16384,
        timeCost: 2,
        parallelism: 2,
      });
      const parsed = parseArgon2Header(hash);
      expect(parsed.memoryCost).toBe(16384);
      expect(parsed.timeCost).toBe(2);
      expect(parsed.parallelism).toBe(2);
    });

    it('rejects a short password', async () => {
      await expect(hashPassword('short', CONFIG)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a non-string password', async () => {
      // @ts-expect-error intentional wrong type
      await expect(hashPassword(12345, CONFIG)).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('verifyPassword', () => {
    it('returns true for a matching password', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
    });

    it('returns false for a wrong password', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      expect(await verifyPassword('wrong password value!', hash)).toBe(false);
    });

    it('returns false on non-string inputs without throwing', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      // @ts-expect-error intentional wrong type
      expect(await verifyPassword(null, hash)).toBe(false);
      // @ts-expect-error intentional wrong type
      expect(await verifyPassword(GOOD_PASSWORD, null)).toBe(false);
    });

    it('promotes a corrupt hash to an AuthError', async () => {
      await expect(verifyPassword(GOOD_PASSWORD, 'not-an-argon2-hash')).rejects.toBeInstanceOf(
        AuthError,
      );
    });
  });

  describe('parseArgon2Header', () => {
    it('parses a known header', () => {
      const parsed = parseArgon2Header(
        '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$Zm9vZm9vZm9v',
      );
      expect(parsed.algorithm).toBe('argon2id');
      expect(parsed.version).toBe(19);
      expect(parsed.memoryCost).toBe(65536);
      expect(parsed.timeCost).toBe(3);
      expect(parsed.parallelism).toBe(4);
    });
    it('throws on unrecognized header', () => {
      expect(() => parseArgon2Header('plain-text')).toThrow(AuthError);
    });
  });

  describe('passwordNeedsRehash', () => {
    it('returns false when parameters match current config', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG);
      expect(passwordNeedsRehash(hash, CONFIG)).toBe(false);
    });

    it('returns true when stored memoryCost is lower', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG, { memoryCost: 8192 });
      expect(passwordNeedsRehash(hash, { ...CONFIG, passwordArgon2MemoryKib: 16384 })).toBe(true);
    });

    it('returns true when stored timeCost is lower', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG, { timeCost: 1 });
      expect(passwordNeedsRehash(hash, { ...CONFIG, passwordArgon2Iterations: 3 })).toBe(true);
    });

    it('returns true when stored parallelism is lower', async () => {
      const hash = await hashPassword(GOOD_PASSWORD, CONFIG, { parallelism: 1 });
      expect(passwordNeedsRehash(hash, { ...CONFIG, passwordArgon2Parallelism: 4 })).toBe(true);
    });

    it('returns true for a wrong algorithm', () => {
      expect(passwordNeedsRehash('$argon2i$v=19$m=65536,t=3,p=4$abc$def', CONFIG)).toBe(true);
    });

    it('returns true for an unparseable hash', () => {
      expect(passwordNeedsRehash('not-argon2', CONFIG)).toBe(true);
    });
  });
});
