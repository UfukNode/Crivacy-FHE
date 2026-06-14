// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  type BuildAdminSessionInput,
  type BuildFirmSessionInput,
  buildSession,
  rotateSession,
  verifyAccessToken,
  verifyRefreshToken,
} from '@/lib/auth';

import { buildTestConfig } from './fixtures';

const CONFIG = buildTestConfig();

const NOW = new Date('2026-04-11T10:00:00Z');

const FIRM_USER_ID = '9e0b12fe-0b2b-4c0c-8f8a-0d1f2c3b4a5e';
const FIRM_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ADMIN_USER_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

const FIRM_INPUT: BuildFirmSessionInput = {
  kind: 'firm',
  userId: FIRM_USER_ID,
  firmId: FIRM_ID,
  role: 'member',
  scopes: ['kyc:read', 'kyc:create'],
  ip: '203.0.113.42',
  userAgent: 'Mozilla/5.0 (Tests)',
};

const ADMIN_INPUT: BuildAdminSessionInput = {
  kind: 'admin',
  userId: ADMIN_USER_ID,
  role: 'support',
  ip: null,
  userAgent: null,
};

describe('auth/sessions', () => {
  describe('buildSession — firm', () => {
    it('returns a fully-populated BuiltSession', async () => {
      const built = await buildSession(FIRM_INPUT, CONFIG, NOW);

      expect(typeof built.accessToken).toBe('string');
      expect(built.accessToken.split('.').length).toBe(3);
      expect(typeof built.refreshToken).toBe('string');
      expect(built.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(built.jti).toMatch(/[0-9a-f-]{36}/);

      expect(built.accessExpiresAt.getTime()).toBe(
        NOW.getTime() + CONFIG.jwtAccessTtlSeconds * 1000,
      );
      expect(built.refreshExpiresAt.getTime()).toBe(
        NOW.getTime() + CONFIG.jwtRefreshTtlSeconds * 1000,
      );
    });

    it('produces a record matching SessionInsertRecord', async () => {
      const built = await buildSession(FIRM_INPUT, CONFIG, NOW);
      const { record } = built;

      expect(record.userId).toBe(FIRM_USER_ID);
      expect(record.userKind).toBe('firm');
      expect(record.jwtJti).toBe(built.jti);
      expect(record.refreshTokenVersion).toBe(1);
      expect(record.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.expiresAt.getTime()).toBe(built.accessExpiresAt.getTime());
      expect(record.refreshExpiresAt.getTime()).toBe(built.refreshExpiresAt.getTime());
      expect(record.ip).toBe('203.0.113.42');
      expect(record.userAgent).toBe('Mozilla/5.0 (Tests)');
    });

    it('normalises missing ip / userAgent to null', async () => {
      const built = await buildSession(
        {
          kind: 'firm',
          userId: FIRM_USER_ID,
          firmId: FIRM_ID,
          role: 'owner',
        },
        CONFIG,
        NOW,
      );
      expect(built.record.ip).toBeNull();
      expect(built.record.userAgent).toBeNull();
    });

    it('access token verifies back to the same firm claims', async () => {
      const built = await buildSession(FIRM_INPUT, CONFIG, NOW);
      const verified = await verifyAccessToken(built.accessToken, CONFIG, NOW);

      expect(verified.kind).toBe('firm');
      expect(verified.sub).toBe(FIRM_USER_ID);
      expect(verified.firmId).toBe(FIRM_ID);
      expect(verified.role).toBe('member');
      expect(verified.scopes).toEqual(['kyc:read', 'kyc:create']);
      expect(verified.jti).toBe(built.jti);
    });

    it('refresh token matches the stored hash', async () => {
      const built = await buildSession(FIRM_INPUT, CONFIG, NOW);
      expect(verifyRefreshToken(built.refreshToken, built.record.refreshTokenHash)).toBe(true);
    });
  });

  describe('buildSession — admin', () => {
    it('produces an admin record without a firmId', async () => {
      const built = await buildSession(ADMIN_INPUT, CONFIG, NOW);
      expect(built.record.userKind).toBe('admin');
      expect(built.record.userId).toBe(ADMIN_USER_ID);
      // SessionInsertRecord has no firmId column; the admin branch carries none.
      // @ts-expect-error runtime guard — firmId must not appear on the record type.
      expect(built.record.firmId).toBeUndefined();
    });

    it('access token verifies back to the same admin claims', async () => {
      const built = await buildSession(ADMIN_INPUT, CONFIG, NOW);
      const verified = await verifyAccessToken(built.accessToken, CONFIG, NOW);
      expect(verified.kind).toBe('admin');
      expect(verified.sub).toBe(ADMIN_USER_ID);
      expect(verified.firmId).toBeNull();
      expect(verified.role).toBe('support');
    });
  });

  describe('buildSession — validation', () => {
    it('rejects an empty userId', async () => {
      await expect(buildSession({ ...FIRM_INPUT, userId: '' }, CONFIG, NOW)).rejects.toMatchObject({
        code: 'jwt_missing_claim',
      });
    });

    it('rejects a firm session without firmId', async () => {
      await expect(
        // @ts-expect-error intentionally drops firmId to exercise the guard
        buildSession({ ...FIRM_INPUT, firmId: undefined }, CONFIG, NOW),
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a firm session with an empty firmId', async () => {
      await expect(buildSession({ ...FIRM_INPUT, firmId: '' }, CONFIG, NOW)).rejects.toMatchObject({
        code: 'jwt_missing_claim',
      });
    });
  });

  describe('rotateSession', () => {
    it('increments refreshTokenVersion from the previous value', async () => {
      const rotated = await rotateSession(
        {
          kind: 'firm',
          userId: FIRM_USER_ID,
          firmId: FIRM_ID,
          role: 'member',
          scopes: ['kyc:read'],
          previousRefreshTokenVersion: 7,
          ip: '198.51.100.1',
          userAgent: 'rotate-agent/1.0',
        },
        CONFIG,
        NOW,
      );
      expect(rotated.record.refreshTokenVersion).toBe(8);
      expect(rotated.record.userKind).toBe('firm');
      expect(rotated.record.ip).toBe('198.51.100.1');
      expect(rotated.record.userAgent).toBe('rotate-agent/1.0');
    });

    it('issues a new jti each rotation', async () => {
      const first = await buildSession(FIRM_INPUT, CONFIG, NOW);
      const second = await rotateSession(
        {
          kind: 'firm',
          userId: FIRM_USER_ID,
          firmId: FIRM_ID,
          role: 'member',
          scopes: ['kyc:read', 'kyc:create'],
          previousRefreshTokenVersion: first.record.refreshTokenVersion,
        },
        CONFIG,
        NOW,
      );
      expect(second.jti).not.toBe(first.jti);
      expect(second.record.refreshTokenVersion).toBe(first.record.refreshTokenVersion + 1);
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('produces an access token that verifies with the new claims', async () => {
      const rotated = await rotateSession(
        {
          kind: 'admin',
          userId: ADMIN_USER_ID,
          role: 'superadmin',
          previousRefreshTokenVersion: 3,
        },
        CONFIG,
        NOW,
      );
      const verified = await verifyAccessToken(rotated.accessToken, CONFIG, NOW);
      expect(verified.kind).toBe('admin');
      expect(verified.sub).toBe(ADMIN_USER_ID);
      expect(verified.role).toBe('superadmin');
      expect(verified.jti).toBe(rotated.jti);
    });

    it('rejects a previousRefreshTokenVersion below 1', async () => {
      await expect(
        rotateSession(
          {
            kind: 'firm',
            userId: FIRM_USER_ID,
            firmId: FIRM_ID,
            role: 'member',
            previousRefreshTokenVersion: 0,
          },
          CONFIG,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'invalid_refresh_token' });
    });

    it('rejects a non-integer previousRefreshTokenVersion', async () => {
      await expect(
        rotateSession(
          {
            kind: 'firm',
            userId: FIRM_USER_ID,
            firmId: FIRM_ID,
            role: 'member',
            previousRefreshTokenVersion: 1.5,
          },
          CONFIG,
          NOW,
        ),
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a firm rotation without a firmId', async () => {
      await expect(
        rotateSession(
          {
            kind: 'firm',
            userId: FIRM_USER_ID,
            role: 'member',
            previousRefreshTokenVersion: 2,
          },
          CONFIG,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'jwt_missing_claim' });
    });

    it('refresh token round-trips via verifyRefreshToken', async () => {
      const rotated = await rotateSession(
        {
          kind: 'admin',
          userId: ADMIN_USER_ID,
          role: 'admin',
          previousRefreshTokenVersion: 1,
        },
        CONFIG,
        NOW,
      );
      expect(verifyRefreshToken(rotated.refreshToken, rotated.record.refreshTokenHash)).toBe(true);
    });
  });
});
