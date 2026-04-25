/**
 * Profile validation schemas — single source of truth for display name
 * and phone number across all layers.
 *
 * Frontend forms and backend handlers both import from here.
 *
 * @module
 */

import { z } from 'zod';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/max';

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

/**
 * Allowed display name characters:
 * - Unicode letters (\p{L}) — covers Latin, Cyrillic, Arabic, CJK, etc.
 * - Unicode digits (\p{N})
 * - Space, dot, hyphen, apostrophe (for names like "O'Brien", "J.-P.")
 *
 * Everything else is rejected upfront — no HTML, no brackets, no code.
 */
const DISPLAY_NAME_CHARS = /^[\p{L}\p{N}\s.\-']+$/u;

/**
 * Display name — 2-100 characters, must contain at least one letter,
 * and only allows safe characters (letters, digits, spaces, `.`, `-`, `'`).
 *
 * Used in: register, complete-registration, profile update.
 * Normalization (NFC, strip HTML/control chars) is done in the handler,
 * not in the schema, because Zod `.transform()` changes the inferred type.
 */
export const displayNameSchema = z
  .string()
  .min(2, 'Display name must be at least 2 characters.')
  .max(100, 'Display name must be at most 100 characters.')
  .regex(DISPLAY_NAME_CHARS, 'Allowed: letters, digits, spaces and special characters ( . ) ( - ) ( \' )')
  .refine((val) => /\p{L}/u.test(val), {
    message: 'Display name must contain at least one letter.',
  });

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/** E.164 structural check — ensures the string looks like a phone number. */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Phone number — E.164 format with per-country validation.
 *
 * Three-pass validation:
 * 1. Regex ensures E.164 structure (fast, cheap)
 * 2. Anti-truncation: raw digits must exactly match what parsePhoneNumber
 *    extracts. This catches inputs like +9055360022183 where the parser
 *    silently truncates to +905536002218 (valid but not what user entered).
 * 3. `isValidPhoneNumber` checks per-country digit count and prefix (metadata-driven)
 *
 * Used in: profile update (backend handler).
 */
export const phoneSchema = z
  .string()
  .regex(E164_REGEX, 'Phone number must be in E.164 format (e.g. +14155552671).')
  .refine((val) => {
    try {
      const parsed = parsePhoneNumber(val);
      if (!parsed?.nationalNumber) return false;
      const rawDigits = val.replace(/\D/g, '');
      const expectedDigits = `${parsed.countryCallingCode}${parsed.nationalNumber}`;
      return rawDigits === expectedDigits;
    } catch {
      return false;
    }
  }, { message: 'Phone number has an incorrect number of digits.' })
  .refine((val) => isValidPhoneNumber(val), {
    message: 'Phone number is not valid for the detected country.',
  });

/** Re-export for frontend form validation (e.g. settings page, phone-input component). */
export { isValidPhoneNumber, parsePhoneNumber };
