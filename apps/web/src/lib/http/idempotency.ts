/**
 * Idempotency-Key middleware — Stripe-style replay safety for every
 * state-changing endpoint that opts in.
 *
 * Protocol:
 *   - Caller sends `Idempotency-Key: <opaque>` on any POST / PATCH /
 *     DELETE they want retry-safe. The value is free-form (UUID, random
 *     bytes, whatever) but MUST be stable across retries of the same
 *     logical operation.
 *   - First request for `(subject, endpoint, key)` runs normally. On
 *     a non-5xx response the middleware persists the `(status, body)`
 *     tuple along with a hash of the request body and a hash of the
 *     key itself.
 *   - Subsequent requests within the TTL return the cached response
 *     byte-for-byte. A retried click, a timed-out network call, or a
 *     mobile app re-submitting after regaining signal all land on the
 *     same canonical outcome instead of creating duplicate state.
 *   - A key reused against a DIFFERENT request body is rejected with
 *     409 `idempotency_mismatch` — Stripe's pattern, forces the caller
 *     to use a fresh key when their intent changes.
 *
 * Security + race posture:
 *   - Key values are SHA-256 hashed before hitting the DB; a leaked
 *     dump cannot replay specific keys.
 *   - Request bodies are also hashed, not stored verbatim — the "body
 *     mismatch" check compares hashes, never the raw payload.
 *   - The INSERT uses `ON CONFLICT DO NOTHING RETURNING` so the win
 *     is race-free: the first request commits, every concurrent retry
 *     sees the row already exists and reads the cached response.
 *   - Non-success responses (5xx, opcodes the handler declines to
 *     cache) do NOT populate the cache — retrying a server-error
 *     request is normally what the user wants.
 *   - Subject scoping (`kind: 'customer'|'firm'|'admin'|'none'` +
 *     `id`) means a customer's key cannot be hijacked by an admin
 *     that happens to know the same key string.
 *
 * The module exposes two functions:
 *   - {@link lookupIdempotencyKey} — called BEFORE the handler runs,
 *     returns a cached response if one exists.
 *   - {@link storeIdempotencyKey} — called AFTER the handler runs,
 *     persists the response so future retries can read it.
 *
 * Both are atomic on the DB side. The wrapping helper
 * {@link withIdempotency} composes them around a handler, but
 * endpoints can call the primitives directly when the request/response
 * flow needs custom handling (streamed bodies, multipart uploads, etc.)
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Default cache lifetime — matches Stripe (24h). */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * TTL applied to a CLAIMED-but-not-yet-completed row. A concurrent
 * retry that finds this row will block-poll for up to {@link CLAIM_POLL_MS}
 * milliseconds waiting for the completion; after the TTL elapses the
 * row is treated as stale and the next retry can re-claim.
 */
export const CLAIM_TTL_SECONDS = 30;

/** Minimum acceptable header length — blocks empty/placeholder keys. */
const MIN_KEY_LENGTH = 8;

/** Maximum acceptable header length — blocks payload abuse. */
const MAX_KEY_LENGTH = 256;

/** HTTP statuses we WILL cache — 2xx + explicit idempotent 4xx errors. */
const CACHEABLE_STATUS = new Set([200, 201, 204, 400, 404, 409, 410, 422]);

/** Sentinel value of `response_status` while the claim is pending. */
const PENDING_STATUS = 0;

/** Max time a concurrent retry waits for the claim holder to finish. */
const CLAIM_POLL_TIMEOUT_MS = 3_000;

/** Poll cadence while waiting on a pending claim. */
const CLAIM_POLL_INTERVAL_MS = 200;

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Subject scoping for a key. `none` is used by endpoints that accept
 * anonymous traffic (e.g. public OAuth token exchange — not applicable
 * to the settings surface but reserves the shape).
 */
export type IdempotencySubjectKind = 'customer' | 'firm' | 'admin' | 'none';

export interface IdempotencySubject {
  readonly kind: IdempotencySubjectKind;
  readonly id: string;
}

/**
 * Input for the lookup step. `endpoint` is a caller-supplied label —
 * not the HTTP path; a route with path params should collapse them
 * to a canonical form (`/api/v1/credentials/{id}`) so retries of
 * different IDs don't share a cache entry.
 */
export interface IdempotencyLookupInput {
  readonly db: CrivacyDatabase;
  readonly endpoint: string;
  readonly subject: IdempotencySubject;
  readonly key: string;
  readonly requestBody: string;
  readonly now: Date;
}

export type IdempotencyLookupResult =
  /** Caller did not send a usable key — handler should run normally. */
  | { readonly status: 'absent' }
  /**
   * First-seen key — this caller atomically CLAIMED the slot by
   * inserting a pending row. Handler should run now, then
   * `storeIdempotencyKey` will UPDATE the pending row with the real
   * response. A concurrent retry hitting the same key blocks on the
   * pending row until we complete (or returns `in_progress` after the
   * poll timeout).
   */
  | { readonly status: 'first_seen' }
  /** Cached response found, return it verbatim instead of running the handler. */
  | { readonly status: 'hit'; readonly response: NextResponse }
  /** Key is reused with a different body — reject with 409. */
  | { readonly status: 'mismatch' }
  /**
   * Another concurrent request with this key is still processing and
   * did not finish within {@link CLAIM_POLL_TIMEOUT_MS}. The caller
   * should return a 409 `idempotency_in_progress` so the client can
   * retry after a short delay.
   */
  | { readonly status: 'in_progress' };

export interface IdempotencyStoreInput {
  readonly db: CrivacyDatabase;
  readonly endpoint: string;
  readonly subject: IdempotencySubject;
  readonly key: string;
  readonly requestBody: string;
  readonly responseStatus: number;
  readonly responseBody: string;
  readonly now: Date;
  readonly ttlSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read + sanity-check the header. Returns the raw key when it passes,
 * `null` for any shape that should be silently ignored (missing,
 * empty, outside length window). We deliberately do NOT 400 on a bad
 * key — callers that don't care about idempotency should not be
 * blocked by a typo'd header.
 */
export function extractIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get('idempotency-key');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length < MIN_KEY_LENGTH || trimmed.length > MAX_KEY_LENGTH) return null;
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Atomically claim `(subject, endpoint, key)` OR look up the existing
 * row. Implements the Stripe-style "claim-first" contract so two
 * concurrent retries with the same key cannot both run the handler:
 *
 *   - The caller's INSERT with `ON CONFLICT DO NOTHING` is atomic at
 *     the DB level; exactly one race winner gets a row back, every
 *     other concurrent retry falls through to the read branch.
 *   - The race loser re-reads the row. If it is still pending, it
 *     polls for up to {@link CLAIM_POLL_TIMEOUT_MS} waiting for the
 *     claim holder to finish; on completion the cached response
 *     returns, on timeout the caller gets `in_progress`.
 *   - Stale claim rows (process crashed between claim and commit)
 *     expire after {@link CLAIM_TTL_SECONDS} and the next retry
 *     re-claims them.
 */
export async function lookupIdempotencyKey(
  input: IdempotencyLookupInput,
): Promise<IdempotencyLookupResult> {
  const keyHash = sha256Hex(input.key);
  const requestHash = sha256Hex(input.requestBody);
  const nowIso = input.now.toISOString();
  const claimExpiresAt = new Date(input.now.getTime() + CLAIM_TTL_SECONDS * 1000).toISOString();

  // --- Step 1. Atomic claim. -------------------------------------------
  //
  // INSERT a pending row. `response_status = 0` marks it as claimed-
  // but-not-committed. The unique index guarantees exactly one winner
  // under concurrent retries; everyone else sees `rows.length === 0`
  // and falls through to the read branch.
  //
  // ON CONFLICT uses `DO UPDATE ... WHERE existing.expires_at <= now()`
  // so an abandoned claim row from a crashed process gets recycled
  // automatically on the next retry after its claim TTL lapses. Both
  // the fresh INSERT and the stale-reclaim UPDATE return a row from
  // RETURNING; only genuine non-expired conflicts return empty and
  // fall through to the read branch.
  const claim = await input.db.execute<{ id: string }>(
    sql`INSERT INTO idempotency_keys
          (subject_kind, subject_id, endpoint, key_hash,
           request_hash, response_status, response_body,
           created_at, expires_at)
        VALUES
          (${input.subject.kind}, ${input.subject.id}, ${input.endpoint},
           ${keyHash}, ${requestHash}, ${PENDING_STATUS}, '',
           ${nowIso}, ${claimExpiresAt})
        ON CONFLICT (subject_kind, subject_id, endpoint, key_hash)
          DO UPDATE SET
            request_hash = EXCLUDED.request_hash,
            response_status = ${PENDING_STATUS},
            response_body = '',
            created_at = EXCLUDED.created_at,
            expires_at = EXCLUDED.expires_at
          WHERE idempotency_keys.expires_at <= EXCLUDED.created_at
        RETURNING id`,
  );

  if (claim.rows.length > 0) {
    // We claimed — either a fresh INSERT or a stale-reclaim UPDATE.
    return { status: 'first_seen' };
  }

  // --- Step 2. Lost the claim — read whatever is there. ----------------
  const existing = await readExistingKey(input.db, input.subject, input.endpoint, keyHash);
  if (existing === null) {
    // Raced with a sweeper delete between our INSERT-with-WHERE and
    // this SELECT. Retry the claim — on the next call we likely win.
    // Returning `in_progress` is the safe signal for the caller.
    return { status: 'in_progress' };
  }

  if (existing.request_hash !== requestHash) {
    return { status: 'mismatch' };
  }

  if (existing.response_status !== PENDING_STATUS) {
    return { status: 'hit', response: buildReplayResponse(existing) };
  }

  // --- Step 3. Pending — poll for completion. --------------------------
  //
  // The claim holder is mid-flight. Wait up to CLAIM_POLL_TIMEOUT_MS,
  // polling every CLAIM_POLL_INTERVAL_MS. If the claim completes, we
  // return the cached response; otherwise `in_progress` so the caller
  // can 409 the client and suggest a retry.
  //
  // The deadline is measured in real wall-clock (`Date.now()`) rather
  // than the injected `input.now`, because the wait is genuinely
  // real-time-bounded — we're sleeping via setTimeout. Tests that
  // inject a past `input.now` therefore do not collapse the poll to
  // a zero-duration window.
  const startedAt = Date.now();
  const deadline = startedAt + CLAIM_POLL_TIMEOUT_MS;
  let lastSeen = existing;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_INTERVAL_MS));
    const polled = await readExistingKey(input.db, input.subject, input.endpoint, keyHash);
    if (polled === null) return { status: 'in_progress' };
    if (polled.response_status !== PENDING_STATUS) {
      return { status: 'hit', response: buildReplayResponse(polled) };
    }
    lastSeen = polled;
  }
  // Still pending after timeout.
  void lastSeen;
  return { status: 'in_progress' };
}

/** Read the raw row without mutating. Returns null when the row is absent. */
async function readExistingKey(
  db: CrivacyDatabase,
  subject: IdempotencySubject,
  endpoint: string,
  keyHash: string,
): Promise<
  | {
      request_hash: string;
      response_status: number;
      response_body: string;
      expires_at: string;
    }
  | null
> {
  const rows = await db.execute<{
    request_hash: string;
    response_status: number;
    response_body: string;
    expires_at: string;
  }>(
    sql`SELECT request_hash, response_status, response_body, expires_at::text
          FROM idempotency_keys
         WHERE subject_kind = ${subject.kind}
           AND subject_id = ${subject.id}
           AND endpoint = ${endpoint}
           AND key_hash = ${keyHash}
         LIMIT 1`,
  );
  return (
    (rows.rows[0] as
      | {
          request_hash: string;
          response_status: number;
          response_body: string;
          expires_at: string;
        }
      | undefined) ?? null
  );
}

function buildReplayResponse(row: {
  readonly response_status: number;
  readonly response_body: string;
}): NextResponse {
  return new NextResponse(row.response_body, {
    status: row.response_status,
    headers: {
      'content-type': 'application/json',
      'idempotency-replay': 'true',
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Persist the handler's response against the pending claim this caller
 * placed in {@link lookupIdempotencyKey}.
 *
 * Guarded UPDATE: the WHERE clause matches the pending row ONLY when
 * the existing row's `request_hash` still equals ours AND its
 * `response_status` is still the pending sentinel. This closes a slow-
 * handler race: if our claim expired (handler > CLAIM_TTL_SECONDS)
 * and a concurrent retry re-claimed the slot with its own request +
 * response, an unguarded UPDATE would have overwritten THEIR
 * committed response with OURS — pinning a stale answer into the
 * cache. The WHERE guard makes the UPDATE a no-op in that case; the
 * caller already returned the response to the original client, and
 * the concurrent retry's cached answer wins for future retries.
 *
 * The `INSERT ... ON CONFLICT DO UPDATE` shape is retained for the
 * rare case where the claim row has been swept between lookup and
 * store (the ON CONFLICT branch re-creates it); the guard still
 * applies because `EXCLUDED.request_hash = our hash` trivially, and
 * `response_status` was PENDING on the freshly-inserted row.
 *
 * Only {@link CACHEABLE_STATUS} responses are persisted — 5xx and
 * other transient errors are treated as non-cached so the next retry
 * can actually complete the operation.
 */
export async function storeIdempotencyKey(
  input: IdempotencyStoreInput,
): Promise<void> {
  if (!CACHEABLE_STATUS.has(input.responseStatus)) return;

  const keyHash = sha256Hex(input.key);
  const requestHash = sha256Hex(input.requestBody);
  const ttl = input.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const expiresAt = new Date(input.now.getTime() + ttl * 1000);

  // UPDATE-only path. The pending claim row already exists (placed
  // by `lookupIdempotencyKey`), so we just commit the response into
  // it. The WHERE guard makes this a no-op if our slot was stolen by
  // a concurrent retry that outlived our CLAIM_TTL window.
  const updated = await input.db.execute<{ id: string }>(
    sql`UPDATE idempotency_keys
          SET response_status = ${input.responseStatus},
              response_body = ${input.responseBody},
              expires_at = ${expiresAt.toISOString()}
        WHERE subject_kind = ${input.subject.kind}
          AND subject_id = ${input.subject.id}
          AND endpoint = ${input.endpoint}
          AND key_hash = ${keyHash}
          AND request_hash = ${requestHash}
          AND response_status = ${PENDING_STATUS}
        RETURNING id`,
  );
  if (updated.rows.length > 0) return;

  // Fallback — claim row was swept or stolen between lookup and here.
  // Re-insert so a subsequent retry within the TTL can still hit the
  // cache; ON CONFLICT DO NOTHING avoids clobbering whatever the
  // thief committed.
  await input.db.execute(
    sql`INSERT INTO idempotency_keys
          (subject_kind, subject_id, endpoint, key_hash,
           request_hash, response_status, response_body,
           created_at, expires_at)
        VALUES
          (${input.subject.kind}, ${input.subject.id}, ${input.endpoint},
           ${keyHash}, ${requestHash}, ${input.responseStatus},
           ${input.responseBody}, ${input.now.toISOString()},
           ${expiresAt.toISOString()})
        ON CONFLICT (subject_kind, subject_id, endpoint, key_hash)
          DO NOTHING`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Mismatch response                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical 409 `idempotency_mismatch` response. Exported
 * so a handler can return it directly without reaching into the
 * internal envelope shape.
 */
export function idempotencyMismatchResponse(requestId: string | null): NextResponse {
  return new NextResponse(
    JSON.stringify({
      error: {
        code: 'idempotency_mismatch',
        message:
          'This Idempotency-Key has already been used with a different request body. Use a new key for a new logical operation.',
      },
      requestId: requestId ?? undefined,
    }),
    {
      status: 409,
      headers: { 'content-type': 'application/json' },
    },
  );
}

/**
 * Build the canonical 409 `idempotency_in_progress` response. Returned
 * when a concurrent retry on the same key is still running after the
 * poll timeout — the client should wait a moment and retry.
 */
export function idempotencyInProgressResponse(requestId: string | null): NextResponse {
  return new NextResponse(
    JSON.stringify({
      error: {
        code: 'idempotency_in_progress',
        message:
          'A concurrent request with this Idempotency-Key is still processing. Retry the request in a moment.',
      },
      requestId: requestId ?? undefined,
    }),
    {
      status: 409,
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    },
  );
}
