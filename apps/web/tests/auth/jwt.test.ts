// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  type AccessClaims,
  AuthError,
  generateRefreshToken,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '@/lib/auth';

import { buildTestConfig } from './fixtures';

const CONFIG = buildTestConfig();

const FIRM_CLAIMS: AccessClaims = {
  kind: 'firm',
  sub: '9e0b12fe-0b2b-4c0c-8f8a-0d1f2c3b4a5e',
  firmId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  role: 'member',
  scopes: ['kyc:read', 'kyc:create'],
};

const ADMIN_CLAIMS: AccessClaims = {
  kind: 'admin',
  sub: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  role: 'support',
  scopes: [],
};

const NOW = new Date('2026-04-11T10:00:00Z');

describe('auth/jwt', () => {
  describe('signAccessToken + verifyAccessToken', () => {
    it('round-trips a firm token', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      expect(typeof signed.token).toBe('string');
      expect(signed.jti).toMatch(/[0-9a-f-]{36}/);
      expect(signed.issuedAt.getTime()).toBe(NOW.getTime());
      expect(signed.expiresAt.getTime()).toBe(NOW.getTime() + CONFIG.jwtAccessTtlSeconds * 1000);

      const verified = await verifyAccessToken(signed.token, CONFIG, NOW);
      expect(verified.kind).toBe('firm');
      expect(verified.sub).toBe(FIRM_CLAIMS.sub);
      expect(verified.firmId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
      expect(verified.role).toBe('member');
      expect(verified.scopes).toEqual(['kyc:read', 'kyc:create']);
      expect(verified.jti).toBe(signed.jti);
    });

    it('round-trips an admin token', async () => {
      const signed = await signAccessToken(ADMIN_CLAIMS, CONFIG, NOW);
      const verified = await verifyAccessToken(signed.token, CONFIG, NOW);
      expect(verified.kind).toBe('admin');
      expect(verified.firmId).toBeNull();
      expect(verified.role).toBe('support');
    });

    it('rejects an expired token', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      const later = new Date(NOW.getTime() + (CONFIG.jwtAccessTtlSeconds + 1) * 1000);
      await expect(verifyAccessToken(signed.token, CONFIG, later)).rejects.toMatchObject({
        code: 'expired_jwt',
      });
    });

    it('rejects a tampered signature', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      // Flip the last character of the signature segment.
      const [header, payload, sig] = signed.token.split('.');
      if (!header || !payload || !sig) {
        throw new Error('expected a 3-segment JWT');
      }
      const flipped = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
      const tampered = [header, payload, flipped].join('.');
      await expect(verifyAccessToken(tampered, CONFIG, NOW)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a wrong issuer', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      const other = { ...CONFIG, jwtIssuer: 'other-issuer' };
      await expect(verifyAccessToken(signed.token, other, NOW)).rejects.toMatchObject({
        code: 'invalid_jwt_issuer',
      });
    });

    it('rejects a wrong audience', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      const other = {
        ...CONFIG,
        jwtFirmAudience: 'nope.firm',
        jwtAdminAudience: 'nope.admin',
      };
      await expect(verifyAccessToken(signed.token, other, NOW)).rejects.toMatchObject({
        code: 'invalid_jwt_audience',
      });
    });

    it('rejects malformed token strings', async () => {
      await expect(verifyAccessToken('not.a.jwt', CONFIG, NOW)).rejects.toBeInstanceOf(AuthError);
      await expect(verifyAccessToken('abc', CONFIG, NOW)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a token signed with a different secret', async () => {
      const signed = await signAccessToken(FIRM_CLAIMS, CONFIG, NOW);
      const other = {
        ...CONFIG,
        jwtSecret: 'yyyy_different_secret_at_least_32_bytes_aa',
      };
      await expect(verifyAccessToken(signed.token, other, NOW)).rejects.toMatchObject({
        code: 'invalid_jwt',
      });
    });
  });

  describe('refresh tokens', () => {
    it('generateRefreshToken returns base64url + hex hash', () => {
      const t = generateRefreshToken();
      expect(t.token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // The hash is the sha256 of the plaintext token.
      expect(sha256(t.token)).toBe(t.tokenHash);
    });

    it('verifyRefreshToken accepts the matching pair', () => {
      const t = generateRefreshToken();
      expect(verifyRefreshToken(t.token, t.tokenHash)).toBe(true);
    });

    it('verifyRefreshToken rejects a mismatched token', () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(verifyRefreshToken(a.token, b.tokenHash)).toBe(false);
    });

    it('verifyRefreshToken returns false for non-string inputs', () => {
      // @ts-expect-error intentional wrong type
      expect(verifyRefreshToken(null, 'x')).toBe(false);
      // @ts-expect-error intentional wrong type
      expect(verifyRefreshToken('x', null)).toBe(false);
    });

    it('verifyRefreshToken returns false on empty hash', () => {
      expect(verifyRefreshToken('anything', '')).toBe(false);
    });

    it('two refresh tokens differ', () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(a.token).not.toBe(b.token);
      expect(a.tokenHash).not.toBe(b.tokenHash);
    });
  });
});
