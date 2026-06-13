// @vitest-environment node
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  AuthError,
  buildOtpauthUrl,
  decodeBase32,
  encodeBase32,
  generateHotpCode,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from '@/lib/auth';

import { buildTestConfig } from './fixtures';

const CONFIG = buildTestConfig();

/**
 * RFC 6238 Appendix B test secret (ASCII "12345678901234567890"),
 * Base32-encoded for the public API. The Base32 form repeats because
 * the byte sequence repeats across the 20-byte boundary.
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/**
 * SHA-1, 6-digit TOTP values derived from the RFC 6238 §B test table
 * by taking the 8-digit TOTP mod 10^6.
 *
 *   unix time       counter (T)      8-digit     6-digit
 *   59              1                94287082    287082
 *   1111111109      37037036         07081804    081804
 *   1111111111      37037037         14050471    050471
 *   1234567890      41152263         89005924    005924
 *   2000000000      66666666         69279037    279037
 *   20000000000     666666666        65353130    353130
 */
const RFC_VECTORS: readonly { nowSeconds: number; code: string }[] = [
  { nowSeconds: 59, code: '287082' },
  { nowSeconds: 1_111_111_109, code: '081804' },
  { nowSeconds: 1_111_111_111, code: '050471' },
  { nowSeconds: 1_234_567_890, code: '005924' },
  { nowSeconds: 2_000_000_000, code: '279037' },
  { nowSeconds: 20_000_000_000, code: '353130' },
];

describe('auth/totp', () => {
  describe('encodeBase32 / decodeBase32', () => {
    it('encodes the RFC secret to the canonical Base32 form', () => {
      expect(encodeBase32(Buffer.from(RFC_SECRET_ASCII, 'utf8'))).toBe(RFC_SECRET_BASE32);
    });

    it('round-trips a random 20-byte buffer', () => {
      const input = Buffer.from([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10, 0x11, 0x12, 0x13, 0x14,
      ]);
      const encoded = encodeBase32(input);
      const decoded = decodeBase32(encoded);
      expect(decoded.equals(input)).toBe(true);
    });

    it('accepts lower-case and whitespace on decode', () => {
      expect(
        decodeBase32('gez dgn bvg y3t qoj qge zdg nbv gy3 tqo jq').equals(
          Buffer.from(RFC_SECRET_ASCII, 'utf8'),
        ),
      ).toBe(true);
    });

    it('rejects non-Base32 characters', () => {
      expect(() => decodeBase32('not-base32!!')).toThrow(AuthError);
    });

    it('rejects empty input', () => {
      expect(() => decodeBase32('')).toThrow(AuthError);
      expect(() => decodeBase32('   ')).toThrow(AuthError);
    });
  });

  describe('generateTotpSecret', () => {
    it('produces a Base32 string of the expected length', () => {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      // 20 bytes -> 32 Base32 chars (no padding).
      expect(secret.length).toBe(32);
    });
    it('produces a different secret on successive calls', () => {
      expect(generateTotpSecret()).not.toBe(generateTotpSecret());
    });
  });

  describe('RFC 6238 test vectors (SHA-1, 6 digits, T0=0, X=30)', () => {
    for (const { nowSeconds, code } of RFC_VECTORS) {
      it(`nowSeconds=${nowSeconds} -> ${code}`, () => {
        expect(generateTotpCode(RFC_SECRET_BASE32, CONFIG, { nowSeconds })).toBe(code);
      });
    }
  });

  describe('generateHotpCode', () => {
    it('accepts an explicit counter and digits', () => {
      const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8');
      expect(generateHotpCode(secret, 1, 6)).toBe('287082');
    });
    it('supports 7- and 8-digit codes', () => {
      const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8');
      expect(generateHotpCode(secret, 1, 8)).toBe('94287082');
      expect(generateHotpCode(secret, 1, 7).length).toBe(7);
    });
    it('rejects a negative counter', () => {
      const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8');
      expect(() => generateHotpCode(secret, -1, 6)).toThrow(AuthError);
    });
    it('pads short results with leading zeros', () => {
      // Pick a counter where the truncation produces a value < 10^5.
      const secret = Buffer.from(RFC_SECRET_ASCII, 'utf8');
      expect(generateHotpCode(secret, 41_152_263, 6)).toBe('005924');
    });
  });

  describe('verifyTotpCode', () => {
    it('accepts the current code', () => {
      const secret = generateTotpSecret();
      const nowSeconds = 1_700_000_000;
      const code = generateTotpCode(secret, CONFIG, { nowSeconds });
      expect(verifyTotpCode(secret, code, CONFIG, { nowSeconds })).toBe(true);
    });

    it('rejects a code from outside the drift window', () => {
      const secret = generateTotpSecret();
      const nowSeconds = 1_700_000_000;
      const earlier = nowSeconds - 60; // 2 steps back, outside ±1
      const stale = generateTotpCode(secret, CONFIG, { nowSeconds: earlier });
      expect(verifyTotpCode(secret, stale, CONFIG, { nowSeconds })).toBe(false);
    });

    it('accepts a code one step in the past (default drift=1)', () => {
      const secret = generateTotpSecret();
      const nowSeconds = 1_700_000_000;
      const prev = generateTotpCode(secret, CONFIG, { nowSeconds: nowSeconds - 30 });
      expect(verifyTotpCode(secret, prev, CONFIG, { nowSeconds })).toBe(true);
    });

    it('accepts a code one step in the future (default drift=1)', () => {
      const secret = generateTotpSecret();
      const nowSeconds = 1_700_000_000;
      const next = generateTotpCode(secret, CONFIG, { nowSeconds: nowSeconds + 30 });
      expect(verifyTotpCode(secret, next, CONFIG, { nowSeconds })).toBe(true);
    });

    it('rejects a wrong-length code', () => {
      expect(verifyTotpCode(RFC_SECRET_BASE32, '1234', CONFIG, { nowSeconds: 59 })).toBe(false);
    });

    it('rejects a non-numeric code', () => {
      expect(verifyTotpCode(RFC_SECRET_BASE32, 'abcdef', CONFIG, { nowSeconds: 59 })).toBe(false);
    });

    it('rejects a non-string code', () => {
      // @ts-expect-error intentional wrong type
      expect(verifyTotpCode(RFC_SECRET_BASE32, 287082, CONFIG, { nowSeconds: 59 })).toBe(false);
    });

    it('returns false on a malformed secret instead of throwing', () => {
      expect(verifyTotpCode('not-base32', '123456', CONFIG, { nowSeconds: 59 })).toBe(false);
    });

    it('respects a drift of 0 (strict current step only)', () => {
      const strict = { ...CONFIG, totpDriftSteps: 0 };
      const secret = generateTotpSecret();
      const nowSeconds = 1_700_000_000;
      const prev = generateTotpCode(secret, strict, { nowSeconds: nowSeconds - 30 });
      expect(verifyTotpCode(secret, prev, strict, { nowSeconds })).toBe(false);
      const curr = generateTotpCode(secret, strict, { nowSeconds });
      expect(verifyTotpCode(secret, curr, strict, { nowSeconds })).toBe(true);
    });
  });

  describe('buildOtpauthUrl', () => {
    it('produces a valid otpauth URL', () => {
      const url = buildOtpauthUrl('JBSWY3DPEHPK3PXP', 'ops@acme-bank.com', CONFIG);
      expect(url.startsWith('otpauth://totp/')).toBe(true);
      expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
      expect(url).toContain('issuer=Crivacy');
      expect(url).toContain('algorithm=SHA1');
      expect(url).toContain('digits=6');
      expect(url).toContain('period=30');
      // Label must be URL-encoded and include issuer prefix.
      expect(url).toContain(encodeURIComponent('Crivacy:ops@acme-bank.com'));
    });

    it('rejects an empty account label', () => {
      expect(() => buildOtpauthUrl('JBSWY3DPEHPK3PXP', '', CONFIG)).toThrow(AuthError);
    });
  });
});
