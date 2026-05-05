/**
 * Email system configuration — validated via Zod.
 *
 * SMTP: Google Workspace relay (noreply@crivacy.io).
 * Rate limits: per-user, per-type, per-window.
 *
 * @module
 */

import { z } from 'zod';

/* ---------- Schema ---------- */

export const emailConfigSchema = z.object({
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /**
     * `true` for implicit TLS (port 465), `false` for STARTTLS (port 587).
     * Default `false` matches the most common Gmail/Workspace relay setup
     * (port 587 + STARTTLS). Override via `SMTP_SECURE=true` for port 465.
     */
    secure: z.boolean().default(false),
    user: z.string().min(1),
    pass: z.string().min(1),
  }),
  /** Accepts plain email ("a@b.com") or RFC 5322 display name format ('"Name" <a@b.com>'). */
  from: z.string().min(1).default('noreply@crivacy.io'),
  /** Accepts plain email or RFC 5322 display name format. */
  replyTo: z.string().min(1).optional(),
  /** Rate limit: max emails per user per hour (all types combined) */
  maxPerUserPerHour: z.number().int().min(1).default(5),
  /** Rate limit: max verification/reset resends per 15 minutes */
  maxResendsPerWindow: z.number().int().min(1).default(3),
  /** Verification email token TTL in seconds (default 24h) */
  verificationTtlSeconds: z.number().int().min(60).default(86400),
  /** Password reset token TTL in seconds (default 1h) */
  resetTtlSeconds: z.number().int().min(60).default(3600),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

/* ---------- Factory ---------- */

/**
 * Build email config from environment variables.
 * Throws on invalid/missing config.
 *
 * Defaults match Google Workspace SMTP relay (port 587 + STARTTLS).
 * Override `SMTP_SECURE=true` and `SMTP_PORT=465` for implicit TLS.
 */
export function buildEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  return emailConfigSchema.parse({
    smtp: {
      host: env['SMTP_HOST'],
      port: Number(env['SMTP_PORT'] ?? '587'),
      secure: env['SMTP_SECURE'] === 'true',
      user: env['SMTP_USER'],
      pass: env['SMTP_PASS'],
    },
    from: env['SMTP_FROM'] ?? 'noreply@crivacy.io',
    replyTo: env['SMTP_REPLY_TO'] || undefined,
    maxPerUserPerHour: Number(env['EMAIL_MAX_PER_USER_PER_HOUR'] ?? '5'),
    maxResendsPerWindow: Number(env['EMAIL_MAX_RESENDS_PER_WINDOW'] ?? '3'),
    verificationTtlSeconds: Number(env['EMAIL_VERIFICATION_TTL_SECONDS'] ?? '86400'),
    resetTtlSeconds: Number(env['EMAIL_RESET_TTL_SECONDS'] ?? '3600'),
  });
}

/**
 * Soft-fail variant of {@link buildEmailConfig}. Returns `null` if SMTP is
 * not configured (missing host/user/pass), instead of throwing. Use this
 * from optional code paths (e.g. dev mode, where email is best-effort).
 */
export function tryBuildEmailConfig(env: Record<string, string | undefined>): EmailConfig | null {
  try {
    return buildEmailConfig(env);
  } catch {
    return null;
  }
}
