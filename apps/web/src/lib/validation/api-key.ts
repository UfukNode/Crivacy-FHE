/**
 * API key validation schemas — single source of truth for API key
 * name, mode, scopes, and expiry across all layers.
 *
 * @module
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid API key scopes. */
export const VALID_API_KEY_SCOPES = [
  'kyc:create',
  'kyc:read',
  'kyc:verify',
  'webhooks:manage',
  'usage:read',
] as const;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** API key name — 1-128 characters. */
export const apiKeyNameSchema = z
  .string()
  .min(1, 'Name is required.')
  .max(128, 'Name must be at most 128 characters.');

/** API key mode — live or test. */
export const apiKeyModeSchema = z.enum(['live', 'test']);

/** API key scopes — 1-8 valid scope strings. */
export const apiKeyScopesSchema = z
  .array(
    z.string().refine(
      (s): s is (typeof VALID_API_KEY_SCOPES)[number] =>
        (VALID_API_KEY_SCOPES as readonly string[]).includes(s),
      { message: 'Invalid scope' },
    ),
  )
  .min(1, 'At least one scope is required.')
  .max(8, 'At most 8 scopes allowed.');

// ---------------------------------------------------------------------------
// Composite schemas
// ---------------------------------------------------------------------------

/** Schema for creating an API key. */
export const createApiKeySchema = z.object({
  name: apiKeyNameSchema,
  mode: apiKeyModeSchema,
  scopes: apiKeyScopesSchema,
  expiresAt: z.string().datetime().optional(),
});
