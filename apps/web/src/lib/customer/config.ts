/**
 * Customer auth configuration.
 * @module
 */

import { z } from 'zod';

import { LOCKOUT_DURATION_MINUTES } from '@/lib/auth/lockout';

export const CustomerAuthConfigSchema = z.object({
  /** Max failed login attempts before lock. */
  maxFailedAttempts: z.number().int().min(1).default(5),
  /** Lock duration in minutes after max failed attempts. */
  lockDurationMinutes: z.number().int().min(1).default(LOCKOUT_DURATION_MINUTES),
  /** Email verification code TTL in seconds (10 minutes). */
  verificationCodeTtlSeconds: z.number().int().min(60).default(600),
  /** Password reset code TTL in seconds (10 minutes). */
  resetCodeTtlSeconds: z.number().int().min(60).default(600),
  /** Max wrong code attempts before code is invalidated. */
  maxCodeAttempts: z.number().int().min(1).default(5),
  /** Max codes per customer per 15-minute window (rate limit). */
  maxCodesPerWindow: z.number().int().min(1).default(3),
  /** Code rate limit window in minutes. */
  codeRateLimitWindowMinutes: z.number().int().min(1).default(15),
  /**
   * Turnstile site key (client-side). REQUIRED — empty string rejected.
   * CLAUDE.md "No Hardcoded Fallbacks" — prod deploy env-missing sessizce
   * test key'e düşmesin, startup'ta fail-loud.
   */
  turnstileSiteKey: z
    .string()
    .min(1, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY is required — set it in .env (use Cloudflare test key `1x00000000000000000000AA` locally).'),
  /** Turnstile secret key (server-side). REQUIRED — same fail-loud rule. */
  turnstileSecretKey: z
    .string()
    .min(1, 'TURNSTILE_SECRET_KEY is required — set it in .env (use Cloudflare test key `1x0000000000000000000000000000000AA` locally).'),
  /** Customer access token TTL in seconds (shorter than firm: 15 min). */
  customerAccessTtlSeconds: z.number().int().min(60).default(900),
  /** Customer refresh token TTL in seconds. */
  customerRefreshTtlSeconds: z.number().int().min(60).default(2592000), // 30d
  /** Remember-me refresh token TTL in days. */
  customerRememberMeTtlDays: z.number().int().min(1).default(30),
  /** Google OAuth Client ID (empty disables Google login). */
  googleClientId: z.string().default(''),
  /** Google OAuth Client Secret. */
  googleClientSecret: z.string().default(''),
  /** Google OAuth redirect URI (must match Google Console config). */
  googleRedirectUri: z.string().default(''),
  /**
   * Legacy: email verification token TTL in seconds.
   * Kept for backwards compat during migration; code-based flow uses verificationCodeTtlSeconds.
   * @deprecated Use verificationCodeTtlSeconds instead.
   */
  verificationTokenTtlSeconds: z.number().int().min(60).default(600),
  /**
   * Legacy: password reset token TTL in seconds.
   * @deprecated Use resetCodeTtlSeconds instead.
   */
  resetTokenTtlSeconds: z.number().int().min(60).default(600),
});

export type CustomerAuthConfig = z.infer<typeof CustomerAuthConfigSchema>;

const DEFAULTS = {
  CUSTOMER_MAX_FAILED_ATTEMPTS: '5',
  CUSTOMER_LOCK_DURATION_MINUTES: String(LOCKOUT_DURATION_MINUTES),
  CUSTOMER_VERIFICATION_CODE_TTL: '600',
  CUSTOMER_RESET_CODE_TTL: '600',
  CUSTOMER_MAX_CODE_ATTEMPTS: '5',
  CUSTOMER_MAX_CODES_PER_WINDOW: '3',
  CUSTOMER_CODE_RATE_LIMIT_WINDOW_MINUTES: '15',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
  TURNSTILE_SECRET_KEY: '',
  CUSTOMER_ACCESS_TTL_SECONDS: '900',
  CUSTOMER_REFRESH_TTL_SECONDS: '2592000',
  CUSTOMER_REMEMBER_ME_TTL_DAYS: '30',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  GOOGLE_REDIRECT_URI: '',
} as const;

export type CustomerAuthEnv = Partial<Record<keyof typeof DEFAULTS, string | undefined>>;

export function loadCustomerAuthConfig(
  env: CustomerAuthEnv = process.env as CustomerAuthEnv,
): CustomerAuthConfig {
  const pick = <K extends keyof typeof DEFAULTS>(key: K): string =>
    env[key] ?? DEFAULTS[key];

  const verificationCodeTtl = Number(pick('CUSTOMER_VERIFICATION_CODE_TTL'));
  const resetCodeTtl = Number(pick('CUSTOMER_RESET_CODE_TTL'));

  const raw = {
    maxFailedAttempts: Number(pick('CUSTOMER_MAX_FAILED_ATTEMPTS')),
    lockDurationMinutes: Number(pick('CUSTOMER_LOCK_DURATION_MINUTES')),
    verificationCodeTtlSeconds: verificationCodeTtl,
    resetCodeTtlSeconds: resetCodeTtl,
    maxCodeAttempts: Number(pick('CUSTOMER_MAX_CODE_ATTEMPTS')),
    maxCodesPerWindow: Number(pick('CUSTOMER_MAX_CODES_PER_WINDOW')),
    codeRateLimitWindowMinutes: Number(pick('CUSTOMER_CODE_RATE_LIMIT_WINDOW_MINUTES')),
    turnstileSiteKey: pick('NEXT_PUBLIC_TURNSTILE_SITE_KEY'),
    turnstileSecretKey: pick('TURNSTILE_SECRET_KEY'),
    customerAccessTtlSeconds: Number(pick('CUSTOMER_ACCESS_TTL_SECONDS')),
    customerRefreshTtlSeconds: Number(pick('CUSTOMER_REFRESH_TTL_SECONDS')),
    customerRememberMeTtlDays: Number(pick('CUSTOMER_REMEMBER_ME_TTL_DAYS')),
    googleClientId: pick('GOOGLE_CLIENT_ID'),
    googleClientSecret: pick('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: pick('GOOGLE_REDIRECT_URI'),
    // Legacy compat — point to same code TTLs
    verificationTokenTtlSeconds: verificationCodeTtl,
    resetTokenTtlSeconds: resetCodeTtl,
  };

  const parsed = CustomerAuthConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Customer auth config invalid: ${parsed.error.message}`);
  }
  return Object.freeze(parsed.data);
}

let cached: CustomerAuthConfig | null = null;

export function getCustomerAuthConfig(): CustomerAuthConfig {
  if (cached === null) {
    cached = loadCustomerAuthConfig();
  }
  return cached;
}

export function resetCustomerAuthConfigForTests(): void {
  cached = null;
}
