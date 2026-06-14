// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuthError,
  constantTimeEqual,
  deserialize,
  loadKeyFromBase64,
  open,
  seal,
  selectKeyForVersion,
  serialize,
} from '@/lib/auth';

import { FIXTURE_TOTP_KEY_BASE64 } from './fixtures';

const KEY = loadKeyFromBase64(FIXTURE_TOTP_KEY_BASE64);

describe('auth/crypto-box', () => {
  describe('loadKeyFromBase64', () => {
    it('decodes a 32-byte base64 key', () => {
      expect(KEY).toBeInstanceOf(Buffer);
      expect(KEY.length).toBe(32);
    });

    it('rejects shorter keys', () => {
      const short = Buffer.alloc(16).toString('base64');
      expect(() => loadKeyFromBase64(short)).toThrow(AuthError);
    });

    it('rejects longer keys', () => {
      const long = Buffer.alloc(48).toString('base64');
      expect(() => loadKeyFromBase64(long)).toThrow(AuthError);
    });
  });

  describe('seal / open', () => {
    it('round-trips a plaintext string', () => {
      const box = seal('JBSWY3DPEHPK3PXP', KEY, 1);
      const opened = open(box, KEY);
      expect(opened.toString('utf8')).toBe('JBSWY3DPEHPK3PXP');
    });

    it('round-trips a plaintext buffer', () => {
      const input = randomBytes(64);
      const box = seal(input, KEY, 1);
      expect(open(box, KEY).equals(input)).toBe(true);
    });

    it('produces a different nonce for each call', () => {
      const a = seal('same input', KEY, 1);
      const b = seal('same input', KEY, 1);
      expect(a.nonce.equals(b.nonce)).toBe(false);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    });

    it('rejects tampered ciphertext (GCM auth tag)', () => {
      const box = seal('important', KEY, 1);
      // Flip one byte in the ciphertext.
      const tampered = Buffer.from(box.ciphertext);
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0x01, 0);
      expect(() => open({ ...box, ciphertext: tampered }, KEY)).toThrow(AuthError);
    });

    it('rejects tampered auth tag', () => {
      const box = seal('important', KEY, 1);
      const tampered = Buffer.from(box.tag);
      tampered.writeUInt8(tampered.readUInt8(0) ^ 0x01, 0);
      expect(() => open({ ...box, tag: tampered }, KEY)).toThrow(AuthError);
    });

    it('rejects a wrong key', () => {
      const box = seal('important', KEY, 1);
      const wrong = randomBytes(32);
      expect(() => open(box, wrong)).toThrow(AuthError);
    });

    it('rejects a non-buffer key', () => {
      // @ts-expect-error intentional wrong type
      expect(() => seal('x', 'not a buffer', 1)).toThrow(AuthError);
    });

    it('rejects a non-positive keyVersion', () => {
      expect(() => seal('x', KEY, 0)).toThrow(AuthError);
      expect(() => seal('x', KEY, -1)).toThrow(AuthError);
    });
  });

  describe('serialize / deserialize', () => {
    it('round-trips through the serialized form', () => {
      const original = seal('hello', KEY, 2);
      const flat = serialize(original);
      expect(flat.keyVersion).toBe(2);
      expect(typeof flat.ciphertextBase64).toBe('string');
      expect(typeof flat.nonceBase64).toBe('string');
      const restored = deserialize(flat);
      expect(open(restored, KEY).toString('utf8')).toBe('hello');
    });

    it('rejects truncated ciphertext', () => {
      expect(() =>
        deserialize({
          ciphertextBase64: Buffer.from([0x01, 0x02]).toString('base64'),
          nonceBase64: Buffer.alloc(12).toString('base64'),
          keyVersion: 1,
        }),
      ).toThrow(AuthError);
    });

    it('rejects wrong-length nonce', () => {
      const box = seal('x', KEY, 1);
      const flat = serialize(box);
      expect(() =>
        deserialize({
          ciphertextBase64: flat.ciphertextBase64,
          nonceBase64: Buffer.alloc(8).toString('base64'),
          keyVersion: 1,
        }),
      ).toThrow(AuthError);
    });
  });

  describe('selectKeyForVersion', () => {
    it('returns the matching key', () => {
      const keys = new Map([
        [1, Buffer.alloc(32, 0x11)],
        [2, Buffer.alloc(32, 0x22)],
      ]);
      expect(selectKeyForVersion({ keyVersion: 2 }, keys).equals(Buffer.alloc(32, 0x22))).toBe(
        true,
      );
    });

    it('throws on unknown version', () => {
      const keys = new Map([[1, Buffer.alloc(32, 0x11)]]);
      expect(() => selectKeyForVersion({ keyVersion: 9 }, keys)).toThrow(AuthError);
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal buffers', () => {
      expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    });
    it('returns false for different buffers', () => {
      expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    });
    it('returns false for length mismatch', () => {
      expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
    });
  });
});
