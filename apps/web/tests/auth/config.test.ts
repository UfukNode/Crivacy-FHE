// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError, loadAuthConfig, resetAuthConfigForTests } from '@/lib/auth';

import { FIXTURE_JWT_SECRET, FIXTURE_TOTP_KEY_BASE64 } from './fixtures';

const baseEnv = () => ({
  AUTH_JWT_SECRET: FIXTURE_JWT_SECRET,
  AUTH_TOTP_ENCRYPTION_KEY: FIXTURE_TOTP_KEY_BASE64,
});

afterEach(() => {
  resetAuthConfigForTests();
});

describe('auth/config', () => {
  it('loads defaults with only the two required secrets set', () => {
    const cfg = loadAuthConfig(baseEnv());
    expect(cfg.jwtIssuer).toBe('crivacy-api');
    expect(cfg.jwtFirmAudience).toBe('crivacy.firm');
    expect(cfg.jwtAdminAudience).toBe('crivacy.admin');
    expect(cfg.jwtAccessTtlSeconds).toBe(3600);
    expect(cfg.jwtRefreshTtlSeconds).toBe(2_592_000);
    expect(cfg.apiKeyBcryptCost).toBe(12);
    expect(cfg.apiKeyGracePeriodHours).toBe(24);
    expect(cfg.passwordArgon2MemoryKib).toBe(65_536);
    expect(cfg.passwordArgon2Iterations).toBe(3);
    expect(cfg.passwordArgon2Parallelism).toBe(4);
    expect(cfg.passwordMinLength).toBe(12);
    expect(cfg.totpEncryptionKeyVersion).toBe(1);
    expect(cfg.totpIssuer).toBe('Crivacy');
    expect(cfg.totpStepSeconds).toBe(30);
    expect(cfg.totpDigits).toBe(6);
    expect(cfg.totpDriftSteps).toBe(1);
  });

  it('is frozen and cannot be mutated in place', () => {
    const cfg = loadAuthConfig(baseEnv());
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as unknown as Record<string, number>)['jwtAccessTtlSeconds'] = 1;
    }).toThrow();
  });

  it('throws when AUTH_JWT_SECRET is missing', () => {
    expect(() => loadAuthConfig({ AUTH_TOTP_ENCRYPTION_KEY: FIXTURE_TOTP_KEY_BASE64 })).toThrow(
      AuthError,
    );
  });

  it('throws when AUTH_JWT_SECRET is shorter than 32 bytes', () => {
    expect(() =>
      loadAuthConfig({
        AUTH_JWT_SECRET: 'short',
        AUTH_TOTP_ENCRYPTION_KEY: FIXTURE_TOTP_KEY_BASE64,
      }),
    ).toThrow(AuthError);
  });

  it('throws when AUTH_TOTP_ENCRYPTION_KEY is missing', () => {
    expect(() => loadAuthConfig({ AUTH_JWT_SECRET: FIXTURE_JWT_SECRET })).toThrow(AuthError);
  });

  it('throws when AUTH_API_KEY_BCRYPT_COST is out of range', () => {
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_API_KEY_BCRYPT_COST: '3' })).toThrow(
      AuthError,
    );
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_API_KEY_BCRYPT_COST: '16' })).toThrow(
      AuthError,
    );
  });

  it('throws when AUTH_TOTP_DIGITS is not 6/7/8', () => {
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_TOTP_DIGITS: '5' })).toThrow(AuthError);
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_TOTP_DIGITS: '9' })).toThrow(AuthError);
  });

  it('throws when AUTH_TOTP_DRIFT_STEPS exceeds max', () => {
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_TOTP_DRIFT_STEPS: '4' })).toThrow(AuthError);
  });

  it('throws when AUTH_PASSWORD_MIN_LENGTH is below 8', () => {
    expect(() => loadAuthConfig({ ...baseEnv(), AUTH_PASSWORD_MIN_LENGTH: '7' })).toThrow(
      AuthError,
    );
  });

  it('coerces numeric env strings to numbers', () => {
    const cfg = loadAuthConfig({
      ...baseEnv(),
      AUTH_JWT_ACCESS_TTL_SECONDS: '7200',
      AUTH_API_KEY_BCRYPT_COST: '10',
      AUTH_TOTP_STEP_SECONDS: '60',
      AUTH_TOTP_DIGITS: '8',
    });
    expect(cfg.jwtAccessTtlSeconds).toBe(7200);
    expect(cfg.apiKeyBcryptCost).toBe(10);
    expect(cfg.totpStepSeconds).toBe(60);
    expect(cfg.totpDigits).toBe(8);
  });
});
