/**
 * Shared test fixtures for the auth suite.
 *
 * The fixture config intentionally uses low cost factors (bcrypt cost
 * 4, argon2id 8 MiB / t=1 / p=1) so the entire suite runs in well
 * under two seconds. Production callers always pass the real
 * `loadAuthConfig()` output, which carries the OWASP-compliant
 * defaults; those defaults are exercised by the `config.test.ts` suite
 * directly rather than by every auth helper test.
 */

import type { AuthConfig } from '@/lib/auth';
import { loadAuthConfig } from '@/lib/auth';

/** Raw base64 AES-256 key — deterministic, generated once with `openssl rand -base64 32`. */
export const FIXTURE_TOTP_KEY_BASE64 = 'n2WQCZSvTNj2YaTH4NaJE3RHsiUJkKKGuIIcbvJwv0Q=';

/** 32+ byte JWT secret for HS256. */
export const FIXTURE_JWT_SECRET = 'test_jwt_secret_at_least_32_bytes_aaaaaa';

/**
 * Build an `AuthConfig` using low-cost parameters tuned for fast
 * local runs. Every helper test imports this and passes it directly
 * to the subject under test.
 */
export function buildTestConfig(overrides: Partial<Record<string, string>> = {}): AuthConfig {
  return loadAuthConfig({
    AUTH_JWT_SECRET: FIXTURE_JWT_SECRET,
    AUTH_JWT_ISSUER: 'crivacy-test',
    AUTH_JWT_FIRM_AUDIENCE: 'crivacy.firm.test',
    AUTH_JWT_ADMIN_AUDIENCE: 'crivacy.admin.test',
    AUTH_JWT_ACCESS_TTL_SECONDS: '3600',
    AUTH_JWT_REFRESH_TTL_SECONDS: '2592000',
    AUTH_API_KEY_BCRYPT_COST: '4',
    AUTH_API_KEY_GRACE_PERIOD_HOURS: '24',
    AUTH_PASSWORD_ARGON2_MEMORY_KIB: '8192',
    AUTH_PASSWORD_ARGON2_ITERATIONS: '1',
    AUTH_PASSWORD_ARGON2_PARALLELISM: '1',
    AUTH_PASSWORD_MIN_LENGTH: '12',
    AUTH_TOTP_ENCRYPTION_KEY: FIXTURE_TOTP_KEY_BASE64,
    AUTH_TOTP_ENCRYPTION_KEY_VERSION: '1',
    AUTH_TOTP_ISSUER: 'Crivacy',
    AUTH_TOTP_STEP_SECONDS: '30',
    AUTH_TOTP_DIGITS: '6',
    AUTH_TOTP_DRIFT_STEPS: '1',
    ...overrides,
  });
}
