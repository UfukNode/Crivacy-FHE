/**
 * Auth validation schemas — single source of truth for email, password,
 * TOTP code, and email verification code across all layers.
 *
 * Frontend forms and backend handlers both import from here.
 *
 * @module
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Password policy constants — single source of truth
// ---------------------------------------------------------------------------

/**
 * Minimum length for NEW passwords, in characters.
 *
 * Authoritative — {@link newPasswordSchema} (frontend + backend
 * validation), `components/shared/password-strength.tsx`
 * (live strength meter), and the `AUTH_PASSWORD_MIN_LENGTH`
 * environment default in `lib/auth/config.ts` all read from this
 * constant. Changing the value requires one edit here; every UI
 * affordance and every server-side hash guard picks it up.
 *
 * Operators can raise the bar at deploy time via the env var, but
 * lowering it below this value is unsupported: the frontend schema
 * still enforces the constant and lower submissions would reach the
 * server only via API direct calls — which already hit the stricter
 * floor inside `hashPassword`.
 */
export const PASSWORD_MIN_LENGTH = 12;

/** Upper bound — guards argon2id hashing cost + payload abuse. */
export const PASSWORD_MAX_LENGTH = 256;

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * RFC 3696 email length limit (64-char local-part + "@" + 255-char domain).
 * Single source of truth — frontend `<input maxLength>` and backend Zod
 * schema both pull this constant so a "valid email per browser" never
 * exceeds what the server will accept.
 */
export const EMAIL_MAX_LENGTH = 320;

/**
 * Email schema — RFC 5322 format, max {@link EMAIL_MAX_LENGTH} characters.
 *
 * Used in: login, register, forgot-password, reset-password, add-email,
 * admin login, dashboard login, status subscribe, firm contact email.
 */
export const emailSchema = z
  .string()
  .email('Please enter a valid email address.')
  .max(EMAIL_MAX_LENGTH, `Email must be at most ${EMAIL_MAX_LENGTH} characters.`);

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * Reject ASCII control characters in password input. Argon2id IS binary-
 * safe, so a NUL byte or escape character does not actually corrupt
 * verification — but a password containing them indicates one of:
 *  (a) a buggy paste from a binary buffer / clipboard injection,
 *  (b) a deliberate boundary-fuzzer attempt to confuse downstream
 *      logging / serialisation,
 *  (c) a copy-paste from a code editor that smuggled in unprintable
 *      glyphs the user cannot reliably reproduce.
 * In all three cases rejecting at the schema layer is safer than
 * accepting and trusting argon2's binary-safety. F-A1-D8-001
 * defense-in-depth.
 *
 * Excludes 0x09 (Tab), 0x0A (LF), 0x0D (CR) — these arrive in some
 * password managers via newline-trailing paste; the {@link existingPasswordSchema}
 * caller is expected to `.trim()` if needed, but a literal embedded
 * Tab is permissible (some passphrase generators emit them).
 */
// Build the regex via the RegExp constructor + String.fromCharCode so
// the source file never embeds raw control bytes (NUL/BS/VT/FF/SO..US)
// that confuse grep/diff/linters. Range covers C0 control chars EXCEPT
// 0x09 (Tab) / 0x0A (LF) / 0x0D (CR).
const CONTROL_CHAR_REGEX = new RegExp(
  '[' +
    String.fromCharCode(0x00) + '-' + String.fromCharCode(0x08) +
    String.fromCharCode(0x0b) +
    String.fromCharCode(0x0c) +
    String.fromCharCode(0x0e) + '-' + String.fromCharCode(0x1f) +
    ']',
);
const CONTROL_CHAR_REJECT_MESSAGE = 'Password contains invalid control characters.';

/**
 * Schema for **new** passwords (register, reset, change, set, complete-registration).
 *
 * Enforces all 4 requirements displayed by the `PasswordStrength` UI component:
 *  1. At least 8 characters
 *  2. At least one uppercase letter
 *  3. At least one digit
 *  4. At least one special character
 *
 * Max 256 characters to prevent hash-DoS.
 *
 * NOTE: Login / verify-password routes should NOT use this schema — they only
 * need `existingPasswordSchema` because they check existing credentials.
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((val) => !CONTROL_CHAR_REGEX.test(val), CONTROL_CHAR_REJECT_MESSAGE)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Schema for existing passwords (login, verify-password, change-password current field).
 *
 * No strength requirements — just ensure it's non-empty and within max length.
 * Max 1024 to allow for legacy passwords and prevent abuse.
 */
export const existingPasswordSchema = z
  .string()
  .min(1, 'Password is required.')
  .max(1024, 'Password too long.')
  .refine((val) => !CONTROL_CHAR_REGEX.test(val), CONTROL_CHAR_REJECT_MESSAGE);

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

/**
 * TOTP code — 6 digits for standard TOTP, up to 8 for recovery codes.
 *
 * Used in: admin login (mandatory), dashboard login (optional),
 * TOTP enrollment verification.
 */
export const totpCodeSchema = z
  .string()
  .min(6, 'TOTP code must be at least 6 digits.')
  .max(8, 'TOTP code must be at most 8 digits.')
  .regex(/^\d+$/, 'TOTP code must be numeric.');

// ---------------------------------------------------------------------------
// Email verification code
// ---------------------------------------------------------------------------

/**
 * 6-digit email verification / password reset code.
 *
 * Used in: verify-email, reset-password.
 */
export const verificationCodeSchema = z
  .string()
  .length(6, 'Code must be exactly 6 digits.')
  .regex(/^\d{6}$/, 'Code must be 6 digits.');
