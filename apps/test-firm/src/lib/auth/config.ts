/**
 * Env-backed auth configuration.
 *
 * A single object carries every tunable in the auth layer. The object is
 * built by `loadAuthConfig()` from a plain record (defaulted from
 * `process.env`) and is validated with Zod: no helper in the auth layer
 * ever reads `process.env` directly. This has two payoffs:
 *
 *   1. Tests can call helpers with a locally-built config (low bcrypt
 *      cost, stub secrets, frozen time) without monkey-patching globals.
 *   2. Production code always goes through `getAuthConfig()`, which
 *      caches the validated object per Node process so repeated reads do
 *      not re-parse the environment.
 *
 * The config is split into five sections matching the helper families
 * that consume it: JWT, API keys, passwords, TOTP, and crypto-box. Field
 * defaults match the policy notes in `PLAN.md` §8 (bcrypt cost 12, 1h
 * access, 30d refresh, argon2id m=64MiB/t=3/p=4, TOTP 30s step, 6 digits).
 *
 * `AUTH_TOTP_ENCRYPTION_KEY` and `AUTH_JWT_SECRET` MUST be 32 bytes when
 * decoded (base64) and 32 bytes of raw text respectively. Generating them:
 *
 *     # jwt secret (raw, 32+ chars)
 *     openssl rand -base64 48
 *     # totp key (decoded == 32 bytes)
 *     openssl rand -base64 32
 */

import { z } from 'zod';

import { PASSWORD_MIN_LENGTH } from '@/lib/validation/auth';

import { AuthError } from './errors';

/* ---------- Zod schema ---------- */

const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

export const AuthConfigSchema = z.object({
  /* JWT */
  jwtSecret: z.string().min(32, 'jwtSecret must be at least 32 raw bytes for HS256'),
  jwtIssuer: z.string().min(1),
  jwtFirmAudience: z.string().min(1),
  jwtAdminAudience: z.string().min(1),
  jwtCustomerAudience: z.string().min(1),
  jwtAccessTtlSeconds: PositiveInt,
  jwtRefreshTtlSeconds: PositiveInt,

  /* API keys */
  apiKeyBcryptCost: z.coerce.number().int().min(4).max(15),
  apiKeyGracePeriodHours: NonNegativeInt,

  /* Passwords */
  passwordArgon2MemoryKib: z.coerce.number().int().min(8192),
  passwordArgon2Iterations: z.coerce.number().int().min(1),
  passwordArgon2Parallelism: z.coerce.number().int().min(1),
  // Operator-tunable but floored at the shared constant so a
  // misconfigured env can never silently relax the rule the UI
  // advertises. Setting it higher is fine; the UI schema will
  // surface the wider gap the first time a user tries to use a
  // between-values password.
  passwordMinLength: z.coerce.number().int().min(PASSWORD_MIN_LENGTH),

  /* TOTP */
  totpEncryptionKey: z.string().min(1),
  totpEncryptionKeyVersion: z.coerce.number().int().positive(),
  totpIssuer: z.string().min(1),
  totpStepSeconds: PositiveInt,
  totpDigits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
  totpDriftSteps: z.coerce.number().int().min(0).max(3),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/* ---------- Defaults ---------- */

/**
 * Fallback values applied when the matching env var is unset. Values that
 * carry secrets (JWT signing key, TOTP data key) have no default and must
 * be provided by the caller.
 */
const DEFAULTS = {
  AUTH_JWT_ISSUER: 'crivacy-api',
  AUTH_JWT_FIRM_AUDIENCE: 'crivacy.firm',
  AUTH_JWT_ADMIN_AUDIENCE: 'crivacy.admin',
  AUTH_JWT_CUSTOMER_AUDIENCE: 'crivacy.customer',
  AUTH_JWT_ACCESS_TTL_SECONDS: '3600', // 1 hour
  AUTH_JWT_REFRESH_TTL_SECONDS: '2592000', // 30 days
  AUTH_API_KEY_BCRYPT_COST: '12',
  AUTH_API_KEY_GRACE_PERIOD_HOURS: '24',
  AUTH_PASSWORD_ARGON2_MEMORY_KIB: '65536', // 64 MiB (OWASP 2024)
  AUTH_PASSWORD_ARGON2_ITERATIONS: '3',
  AUTH_PASSWORD_ARGON2_PARALLELISM: '4',
  // Default mirrors the shared PASSWORD_MIN_LENGTH constant — single
  // source of truth for the rule that the frontend schema, the UI
  // strength meter, and the hashPassword guard all honour.
  AUTH_PASSWORD_MIN_LENGTH: String(PASSWORD_MIN_LENGTH),
  AUTH_TOTP_ENCRYPTION_KEY_VERSION: '1',
  AUTH_TOTP_ISSUER: 'Crivacy',
  AUTH_TOTP_STEP_SECONDS: '30',
  AUTH_TOTP_DIGITS: '6',
  AUTH_TOTP_DRIFT_STEPS: '1',
} as const;

/**
 * Union of the env keys we read. Declared explicitly so a typo in a
 * caller's override dictionary is a compile-time error.
 */
export type AuthEnv = Partial<Record<keyof typeof DEFAULTS | AuthRequiredEnv, string | undefined>>;

export type AuthRequiredEnv = 'AUTH_JWT_SECRET' | 'AUTH_TOTP_ENCRYPTION_KEY';

/* ---------- Loader ---------- */

/**
 * Build a validated `AuthConfig` from an environment record.
 *
 * The caller can either pass an explicit record (used by tests) or omit
 * the argument to read `process.env`. The returned object is frozen so it
 * cannot be mutated in place.
 */
export function loadAuthConfig(env: AuthEnv = process.env as AuthEnv): AuthConfig {
  const pick = <K extends keyof typeof DEFAULTS>(key: K): string => env[key] ?? DEFAULTS[key];

  const jwtSecret = env.AUTH_JWT_SECRET;
  const totpKey = env.AUTH_TOTP_ENCRYPTION_KEY;
  if (typeof jwtSecret !== 'string' || jwtSecret.length === 0) {
    throw new AuthError('auth_config_invalid', 'AUTH_JWT_SECRET is required');
  }
  if (typeof totpKey !== 'string' || totpKey.length === 0) {
    throw new AuthError(
      'auth_config_invalid',
      'AUTH_TOTP_ENCRYPTION_KEY is required (32 bytes, base64-encoded)',
    );
  }

  const raw = {
    jwtSecret,
    jwtIssuer: pick('AUTH_JWT_ISSUER'),
    jwtFirmAudience: pick('AUTH_JWT_FIRM_AUDIENCE'),
    jwtAdminAudience: pick('AUTH_JWT_ADMIN_AUDIENCE'),
    jwtCustomerAudience: pick('AUTH_JWT_CUSTOMER_AUDIENCE'),
    jwtAccessTtlSeconds: pick('AUTH_JWT_ACCESS_TTL_SECONDS'),
    jwtRefreshTtlSeconds: pick('AUTH_JWT_REFRESH_TTL_SECONDS'),
    apiKeyBcryptCost: pick('AUTH_API_KEY_BCRYPT_COST'),
    apiKeyGracePeriodHours: pick('AUTH_API_KEY_GRACE_PERIOD_HOURS'),
    passwordArgon2MemoryKib: pick('AUTH_PASSWORD_ARGON2_MEMORY_KIB'),
    passwordArgon2Iterations: pick('AUTH_PASSWORD_ARGON2_ITERATIONS'),
    passwordArgon2Parallelism: pick('AUTH_PASSWORD_ARGON2_PARALLELISM'),
    passwordMinLength: pick('AUTH_PASSWORD_MIN_LENGTH'),
    totpEncryptionKey: totpKey,
    totpEncryptionKeyVersion: pick('AUTH_TOTP_ENCRYPTION_KEY_VERSION'),
    totpIssuer: pick('AUTH_TOTP_ISSUER'),
    totpStepSeconds: pick('AUTH_TOTP_STEP_SECONDS'),
    totpDigits: Number(pick('AUTH_TOTP_DIGITS')),
    totpDriftSteps: pick('AUTH_TOTP_DRIFT_STEPS'),
  };

  const parsed = AuthConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AuthError(
      'auth_config_invalid',
      `Auth config validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`,
      { cause: parsed.error },
    );
  }
  return Object.freeze(parsed.data);
}

/* ---------- Per-process cache ---------- */

let cached: AuthConfig | null = null;

/**
 * Return the singleton config for the current process. Built lazily on
 * the first call. Tests can call `resetAuthConfigForTests()` to drop the
 * cache between cases.
 */
export function getAuthConfig(): AuthConfig {
  if (cached === null) {
    cached = loadAuthConfig();
  }
  return cached;
}

/**
 * Drop the cached config. Only for test suites that mutate the
 * environment between cases.
 */
export function resetAuthConfigForTests(): void {
  cached = null;
}
