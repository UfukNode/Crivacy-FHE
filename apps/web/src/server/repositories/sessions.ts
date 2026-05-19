/**
 * KYC session repository — data access layer for `kyc_sessions`.
 *
 * Every function accepts `(db, ...)` so it works with both the process
 * singleton and a test-injected handle. No module-level state; no
 * side-effects on import.
 *
 * @module
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { kycSessions } from '@/lib/db/schema';
import type { KycSession } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Refined KYC session type for the B2B flow. After Phase F flipped the
 * Drizzle nullability of `firm_id`/`user_ref`/`created_by_api_key_id`/
 * `level` (because customer-flow rows have those columns NULL), the
 * unified `KycSession` type carries them as `string | null`. The B2B
 * repository's queries all filter on `firmId` (only matches non-null
 * b2b rows), so every row returned by these helpers is guaranteed
 * non-null on the b2b columns. This refinement re-projects that
 * runtime invariant into the type system so the API handlers
 * (`server/handlers/sessions.ts`) keep their pre-Phase-F call shape.
 */
export type B2bKycSession = Omit<
  KycSession,
  'firmId' | 'userRef' | 'createdByApiKeyId' | 'level'
> & {
  readonly firmId: string;
  readonly userRef: string;
  readonly createdByApiKeyId: string;
  readonly level: NonNullable<KycSession['level']>;
};

function asB2b(row: KycSession): B2bKycSession {
  // The CHECK constraint `kyc_sessions_kind_invariant` guarantees b2b
  // rows have non-null firmId/userRef/createdByApiKeyId/level. The
  // assertion mirrors the repo-level WHERE filter which only selects
  // b2b rows; any drift would be a corrupt-row scenario surfaced by
  // the DB constraint, not by this assertion.
  return row as unknown as B2bKycSession;
}

export interface CreateSessionInput {
  readonly firmId: string;
  readonly userRef: string;
  readonly apiKeyId: string;
  readonly workflow: 'identity' | 'address';
  readonly level: 'basic' | 'enhanced';
  readonly diditWorkflowId: string;
  readonly diditSessionId: string | null;
  readonly callbackUrl: string | null;
  readonly returnUrl: string | null;
  readonly metadata: Record<string, unknown>;
  readonly expiresAt: Date;
}

export interface SessionListFilters {
  readonly firmId: string;
  readonly status?: string;
  readonly userRef?: string;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
  readonly cursor?: { ts: Date; id: string };
  readonly limit: number;
}

export interface SessionListResult {
  readonly items: readonly B2bKycSession[];
  readonly nextCursor: { ts: Date; id: string } | null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSession(
  db: CrivacyDatabase,
  input: CreateSessionInput,
): Promise<B2bKycSession> {
  const rows = await db
    .insert(kycSessions)
    .values({
      // Sprint 7: explicit kind discriminator on every insert. This
      // repository creates B2B sessions only — customer-flow inserts
      // live in `customer-kyc.ts`'s handleStartIdentity / handleStartAddress
      // and route through this same table with `kind: 'customer'`.
      kind: 'b2b',
      firmId: input.firmId,
      userRef: input.userRef,
      createdByApiKeyId: input.apiKeyId,
      workflow: input.workflow,
      level: input.level,
      diditWorkflowId: input.diditWorkflowId,
      diditSessionId: input.diditSessionId,
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
      metadata: input.metadata,
      expiresAt: input.expiresAt,
      status: 'pending',
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Session insert returned no rows.');
  }
  return asB2b(row);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function findSessionById(
  db: CrivacyDatabase,
  firmId: string,
  sessionId: string,
): Promise<B2bKycSession | null> {
  const rows = await db
    .select()
    .from(kycSessions)
    .where(and(eq(kycSessions.id, sessionId), eq(kycSessions.firmId, firmId)))
    .limit(1);

  const row = rows[0];
  return row !== undefined ? asB2b(row) : null;
}

export async function findActiveSessionByUserRef(
  db: CrivacyDatabase,
  firmId: string,
  userRef: string,
  workflow: 'identity' | 'address',
): Promise<B2bKycSession | null> {
  const rows = await db
    .select()
    .from(kycSessions)
    .where(
      and(
        eq(kycSessions.firmId, firmId),
        eq(kycSessions.userRef, userRef),
        eq(kycSessions.workflow, workflow),
        sql`${kycSessions.status} in ('pending','in_progress','identity_approved','address_in_progress')`,
      ),
    )
    .limit(1);

  const row = rows[0];
  return row !== undefined ? asB2b(row) : null;
}

// ---------------------------------------------------------------------------
// List (keyset pagination)
// ---------------------------------------------------------------------------

export async function listSessions(
  db: CrivacyDatabase,
  filters: SessionListFilters,
): Promise<SessionListResult> {
  const conditions = [eq(kycSessions.firmId, filters.firmId)];

  if (filters.status !== undefined) {
    conditions.push(sql`${kycSessions.status} = ${filters.status}`);
  }
  if (filters.userRef !== undefined) {
    conditions.push(eq(kycSessions.userRef, filters.userRef));
  }
  if (filters.createdAfter !== undefined) {
    conditions.push(gte(kycSessions.createdAt, filters.createdAfter));
  }
  if (filters.createdBefore !== undefined) {
    conditions.push(lte(kycSessions.createdAt, filters.createdBefore));
  }
  if (filters.cursor !== undefined) {
    conditions.push(
      sql`(${kycSessions.createdAt}, ${kycSessions.id}) < (${filters.cursor.ts}, ${filters.cursor.id})`,
    );
  }

  // Over-fetch by 1 to detect hasMore
  const fetchLimit = filters.limit + 1;

  const rows = await db
    .select()
    .from(kycSessions)
    .where(and(...conditions))
    .orderBy(desc(kycSessions.createdAt), desc(kycSessions.id))
    .limit(fetchLimit);

  const hasMore = rows.length > filters.limit;
  const items = (hasMore ? rows.slice(0, filters.limit) : rows).map(asB2b);

  let nextCursor: SessionListResult['nextCursor'] = null;
  if (hasMore) {
    const last = items[items.length - 1];
    if (last !== undefined) {
      nextCursor = { ts: last.createdAt, id: last.id };
    }
  }

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateSessionStatus(
  db: CrivacyDatabase,
  sessionId: string,
  status: KycSession['status'],
  extra?: {
    completedAt?: Date;
    failureReason?: string;
    diditSessionId?: string;
    diditDecisionPayload?: unknown;
    /**
     * Sprint 7 Phase D — defence-in-depth kind narrowing. When supplied,
     * the UPDATE only fires if the row's `kind` matches; this prevents a
     * future bug from letting a B2B caller mutate a customer-flow row (or
     * vice versa) even if `sessionId` collisions ever materialize. The
     * partial unique indexes are kind-aware, but `kyc_sessions.id` is
     * not — narrowing here is the cheapest belt-and-suspenders we get.
     */
    kind?: 'customer' | 'b2b';
  },
): Promise<KycSession | null> {
  const whereClause =
    extra?.kind !== undefined
      ? and(eq(kycSessions.id, sessionId), eq(kycSessions.kind, extra.kind))
      : eq(kycSessions.id, sessionId);

  const rows = await db
    .update(kycSessions)
    .set({
      status,
      updatedAt: new Date(),
      ...(extra?.completedAt !== undefined ? { completedAt: extra.completedAt } : {}),
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      ...(extra?.diditSessionId !== undefined ? { diditSessionId: extra.diditSessionId } : {}),
      ...(extra?.diditDecisionPayload !== undefined
        ? { diditDecisionPayload: extra.diditDecisionPayload }
        : {}),
    })
    .where(whereClause)
    .returning();

  return rows[0] ?? null;
}

/**
 * Cancel a session — only if it is still in a non-terminal state.
 * Returns the updated row, or null if the session was already terminal.
 */
export async function cancelSession(
  db: CrivacyDatabase,
  firmId: string,
  sessionId: string,
  now: Date,
): Promise<B2bKycSession | null> {
  const rows = await db
    .update(kycSessions)
    .set({
      status: 'expired',
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(kycSessions.id, sessionId),
        eq(kycSessions.firmId, firmId),
        sql`${kycSessions.status} in ('pending','in_progress','identity_approved','address_in_progress')`,
      ),
    )
    .returning();

  const row = rows[0];
  return row !== undefined ? asB2b(row) : null;
}

/**
 * Find the linked session for the opposite workflow phase.
 * E.g., given an 'identity' session → find the 'address' session for
 * the same (firmId, userRef).
 */
export async function findLinkedSession(
  db: CrivacyDatabase,
  firmId: string,
  userRef: string,
  workflow: 'identity' | 'address',
): Promise<B2bKycSession | null> {
  const otherWorkflow = workflow === 'identity' ? 'address' : 'identity';
  return findActiveSessionByUserRef(db, firmId, userRef, otherWorkflow);
}
