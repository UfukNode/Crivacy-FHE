/**
 * Admin validation schemas — single source of truth for firm management,
 * RBAC, and other admin-only operations.
 *
 * @module
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Firm fields
// ---------------------------------------------------------------------------

/** Firm name — 1-256 characters. */
export const firmNameSchema = z
  .string()
  .min(1, 'Firm name is required.')
  .max(256, 'Firm name must be at most 256 characters.');

/** Firm slug — lowercase alphanumeric + hyphens, 2-64 characters. */
export const firmSlugSchema = z
  .string()
  .min(2, 'Slug must be at least 2 characters.')
  .max(64, 'Slug must be at most 64 characters.')
  .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens.');

/** Firm tier. */
export const firmTierSchema = z.enum(['free', 'starter', 'pro', 'enterprise']);

/**
 * ISO 3166-1 alpha-2 country code. Normalises to uppercase + enforces
 * `[A-Z]{2}` so `tr`, `TR`, `Tr`, `T1`, `T-`, and 3-letter alpha-3
 * codes (`TUR`) all resolve to the same canonical form (AUD-X-VAL-001).
 */
export const countryCodeSchema = z
  .string()
  .length(2, 'Country code must be exactly 2 characters.')
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z]{2}$/, 'Country code must be ISO 3166-1 alpha-2 (e.g. US, TR, GB).'),
  );

// ---------------------------------------------------------------------------
// Admin login challenge
// ---------------------------------------------------------------------------

/**
 * Challenge token — 64-character hex string (32 random bytes, hex-encoded).
 *
 * Used in: admin two-step login, step 2 (verify-totp).
 */
export const adminChallengeTokenSchema = z
  .string()
  .length(64, 'Challenge token must be exactly 64 characters.')
  .regex(/^[0-9a-f]+$/, 'Challenge token must be a hex string.');

/**
 * Turnstile token — non-empty string from the Cloudflare widget.
 *
 * Used in: admin login step 1, customer login, register, forgot-password.
 */
export const turnstileTokenSchema = z
  .string()
  .min(1, 'Turnstile verification is required.')
  // Cloudflare Turnstile token bodies are typically 1-2 KB; 4 KB is a
  // generous ceiling to defend against attacker-supplied mega-strings
  // that would burn CPU on downstream verify (AUD-X-VAL-002).
  .max(4096, 'Turnstile token is invalid.');
