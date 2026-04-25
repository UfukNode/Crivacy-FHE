/**
 * Common validation primitives — reused across all domain-specific schemas.
 *
 * Single source of truth for shared Zod pieces like UUID format so every
 * handler that accepts an identifier enforces identical rules.
 *
 * @module
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

/**
 * UUID schema — matches every `uuid` DB column in the Crivacy schema.
 *
 * Used for:
 * - Route params (ticket ID, category ID, message ID, attachment storage key)
 * - Body fields that reference other rows (assignedTo, categoryId, …)
 * - Query filters that select by ID (assignedTo, categoryId)
 */
export const uuidSchema = z.string().uuid('Invalid UUID format.');
