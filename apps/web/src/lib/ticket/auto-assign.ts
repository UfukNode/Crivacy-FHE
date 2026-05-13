/**
 * Ticket auto-assignment.
 *
 * Used when a customer opens a ticket that explicitly requests
 * support routing (via the literal `@support` chip in the first
 * message). The algorithm picks one assignee from the category's
 * admin pool by ranking candidates on current open-ticket load with
 * a small deterministic jitter as a tiebreak. Superadmins and locked
 * admins are always excluded so the pool stays focused on front-line
 * support capacity.
 *
 * Pool resolution
 * ---------------
 *   1. Read `ticket_category_admins` for the category. If the pool
 *      is non-empty AFTER the eligibility filter, use it.
 *   2. Otherwise fall back to every active `admin` or `support`
 *      admin user (role-restricted). This keeps the chip functional
 *      in environments where the per-category pool has not been
 *      configured yet.
 *
 * Chip detection
 * --------------
 * The chip is the case-insensitive literal `@support` surrounded by
 * whitespace or start/end of string. A UUID-style mention like
 * `@{...}` is NOT treated as a chip; the two lexemes are disjoint.
 *
 * @module
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Chip detection
// ---------------------------------------------------------------------------

/**
 * Matches the literal `@support` chip -- a word-boundary-delimited
 * token that may appear anywhere in the body. We intentionally keep
 * the regex simple: exactly `@support`, no trailing `-team` or other
 * variants, so operators have one well-known incantation.
 */
const SUPPORT_CHIP_PATTERN = /(^|\s)@support(\s|$|[.,!?;:])/i;

/**
 * Return `true` if the first message body contains the `@support`
 * routing chip. Whitespace-safe and case-insensitive.
 */
export function hasSupportChip(body: string): boolean {
  return SUPPORT_CHIP_PATTERN.test(body);
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Eligible assignee roles. `superadmin` is deliberately excluded:
 * the take-over endpoint is their escape hatch; they should not be
 * burdened with front-line triage by default.
 */
const ELIGIBLE_ROLES = ['admin', 'support'] as const;

/**
 * A pool candidate with the signals we rank on. Load is the number
 * of currently-open tickets already assigned to this admin.
 */
interface Candidate {
  readonly adminUserId: string;
  readonly role: (typeof ELIGIBLE_ROLES)[number];
  readonly openLoad: number;
}

/**
 * Deterministic per-call jitter so back-to-back `@support` tickets
 * with identical loads do not all land on the lowest-UUID admin.
 * We use `Math.random()` scoped to the pick so the SQL plan stays
 * cacheable; determinism across tests is handled by callers
 * stubbing `Math.random`.
 */
function jitter(): number {
  return Math.random();
}

/**
 * Resolve the eligible admin pool for `categoryId` following the
 * rules documented at the top of the file. Returns the set of
 * admin user IDs that should be scored (pre-load-ranking).
 */
async function resolvePool(
  db: CrivacyDatabase,
  categoryId: string,
): Promise<readonly string[]> {
  // Step 1 -- per-category pool, filtered by eligibility.
  const categoryPool = await db
    .select({
      adminUserId: schema.ticketCategoryAdmins.adminUserId,
    })
    .from(schema.ticketCategoryAdmins)
    .innerJoin(
      schema.adminUsers,
      eq(schema.ticketCategoryAdmins.adminUserId, schema.adminUsers.id),
    )
    .where(
      and(
        eq(schema.ticketCategoryAdmins.categoryId, categoryId),
        isNull(schema.adminUsers.lockedAt),
        inArray(schema.adminUsers.role, [...ELIGIBLE_ROLES]),
      ),
    );

  if (categoryPool.length > 0) {
    return categoryPool.map((r) => r.adminUserId);
  }

  // Step 2 -- global fallback: every active admin/support user.
  const globalPool = await db
    .select({ adminUserId: schema.adminUsers.id })
    .from(schema.adminUsers)
    .where(
      and(
        isNull(schema.adminUsers.lockedAt),
        inArray(schema.adminUsers.role, [...ELIGIBLE_ROLES]),
      ),
    );

  return globalPool.map((r) => r.adminUserId);
}

/**
 * Load-and-jitter ranking. Picks the admin with the fewest currently
 * open tickets (`open`, `in_progress`, `waiting_customer`). Ties are
 * broken by per-call jitter so distribution is fair across equal-load
 * candidates.
 *
 * Returns `null` when the pool resolves to an empty set -- the
 * caller should then leave the ticket unassigned (the existing
 * fan-out notification still fires).
 */
export async function pickAutoAssignee(
  db: CrivacyDatabase,
  categoryId: string,
): Promise<string | null> {
  const poolIds = await resolvePool(db, categoryId);
  if (poolIds.length === 0) return null;

  // Join admin_users with a per-admin open-ticket COUNT so ranking
  // only needs a single round-trip. The LEFT JOIN handles admins
  // with zero open tickets (their COUNT is NULL, coerced to 0).
  const loadRows = await db
    .select({
      adminUserId: schema.adminUsers.id,
      role: schema.adminUsers.role,
      openLoad: sql<number>`coalesce(count(${schema.tickets.id}), 0)::int`,
    })
    .from(schema.adminUsers)
    .leftJoin(
      schema.tickets,
      and(
        eq(schema.tickets.assignedTo, schema.adminUsers.id),
        or(
          eq(schema.tickets.status, 'open'),
          eq(schema.tickets.status, 'in_progress'),
          eq(schema.tickets.status, 'waiting_customer'),
        ),
      ),
    )
    .where(inArray(schema.adminUsers.id, [...poolIds]))
    .groupBy(schema.adminUsers.id, schema.adminUsers.role);

  const candidates: Candidate[] = loadRows
    .filter(
      (r): r is typeof r & { role: (typeof ELIGIBLE_ROLES)[number] } =>
        (ELIGIBLE_ROLES as readonly string[]).includes(r.role),
    )
    .map((r) => ({
      adminUserId: r.adminUserId,
      role: r.role,
      openLoad: r.openLoad,
    }));

  if (candidates.length === 0) return null;

  // Sort by open load ASC, deterministic jitter as tiebreak. Sorting
  // in JS keeps the SQL plan simple; the pool is at most a few dozen
  // rows in practice.
  const sorted = [...candidates].sort((a, b) => {
    const loadDelta = a.openLoad - b.openLoad;
    if (loadDelta !== 0) return loadDelta;
    return jitter() - 0.5;
  });

  return sorted[0]?.adminUserId ?? null;
}
