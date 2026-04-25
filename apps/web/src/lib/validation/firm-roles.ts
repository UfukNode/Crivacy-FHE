/**
 * Firm-user role validation — derived from the central role module
 * so `z.enum` always matches `FIRM_ROLES` without hand-rolled
 * duplicates.
 *
 * Consumers: invite endpoint (body.role), role-change endpoint,
 * admin panel dropdowns.
 *
 * @module
 */

import { z } from 'zod';

import { FIRM_ROLES } from '@/lib/firm/roles';

/**
 * `[...]` cast needed because `z.enum` wants a mutable tuple while
 * `FIRM_ROLES.map(...)` is readonly. The shape of the allowed set
 * is still derived automatically from the role module.
 */
const FIRM_ROLE_IDS = FIRM_ROLES.map((r) => r.id) as unknown as [string, ...string[]];

export const firmRoleSchema = z.enum(FIRM_ROLE_IDS, { message: 'Invalid role.' });
