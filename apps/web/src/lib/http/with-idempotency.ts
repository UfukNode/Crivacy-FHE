/**
 * Idempotency HOF — wraps an endpoint handler so the caller can send
 * an `Idempotency-Key` header for retry safety.
 *
 * Usage (from a route handler, after rate limit + body parse):
 *
 *   return withIdempotency(
 *     {
 *       ctx,
 *       endpoint: 'customer.profile.change-password',
 *       subject: { kind: 'customer', id: ctx.customer.id },
 *       body,
 *     },
 *     async () => {
 *       // normal handler work
 *       return ctx.json({ changed: true });
 *     },
 *   );
 *
 * Behavior:
 *
 *   - Caller omitted the header → HOF just runs the handler. Zero
 *     DB cost and no caching; the endpoint behaves like before.
 *
 *   - Header present, never seen before → HOF runs the handler,
 *     captures the response body, stores `(status, body)` under
 *     `(subject, endpoint, key)` and returns the original response.
 *     A retry within the TTL hits the cache and skips the handler.
 *
 *   - Header present, previously seen with the SAME request body →
 *     HOF returns the cached response byte-for-byte with an
 *     `Idempotency-Replay: true` header. Handler does NOT run.
 *
 *   - Header present, previously seen with a DIFFERENT request body →
 *     HOF returns a 409 `idempotency_mismatch`. Handler does NOT run.
 *     The caller is expected to use a fresh key for a new logical
 *     operation.
 *
 *   - Handler THROWS → HOF does not cache anything. The error
 *     propagates and a retry can run the handler again (correct
 *     behavior for transient failures).
 *
 *   - Handler returns a 5xx → HOF does not cache (driven by
 *     `storeIdempotencyKey`'s CACHEABLE_STATUS set). Retries run
 *     the handler again so the operation can still succeed.
 *
 * The body hash uses `JSON.stringify(body)` — callers should pass
 * the Zod-parsed body (not the raw request text) so equivalent JSON
 * with reordered keys or extra fields Zod strips hashes to the
 * same value.
 *
 * @module
 */

import type { NextRequest, NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';

import {
  extractIdempotencyKey,
  idempotencyInProgressResponse,
  idempotencyMismatchResponse,
  lookupIdempotencyKey,
  storeIdempotencyKey,
  type IdempotencySubject,
} from './idempotency';

/* -------------------------------------------------------------------------- */
/*  Input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a route context this HOF needs. Matches the fields
 * every audience's context already exposes — customer / firm / admin
 * all satisfy it without casting.
 */
export interface IdempotencyCapableContext {
  readonly db: CrivacyDatabase;
  readonly request: NextRequest;
  readonly requestId: string;
  readonly now: Date;
}

export interface WithIdempotencyInput {
  readonly ctx: IdempotencyCapableContext;
  /**
   * Stable identifier for the route. Use a dotted form so audit /
   * observability can filter cheaply (e.g.
   * `'customer.profile.change-password'`). Do NOT include path
   * params — collapse them to a canonical form or scope the subject.
   */
  readonly endpoint: string;
  readonly subject: IdempotencySubject;
  /**
   * The parsed request body (or whatever canonical value represents
   * the request). Hashed via `JSON.stringify` for the key-reuse-but-
   * different-body detection.
   */
  readonly body: unknown;
}

/* -------------------------------------------------------------------------- */
/*  HOF                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a handler invocation with idempotency lookup + cache.
 *
 * See module header for full behavior. The generic is parameterized
 * on the handler's return type so TypeScript keeps the precise
 * `NextResponse` subtype through the pipeline.
 */
export async function withIdempotency(
  input: WithIdempotencyInput,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const rawKey = extractIdempotencyKey(input.ctx.request);
  if (rawKey === null) {
    // No key — fast path. The HOF is effectively a no-op, so the
    // endpoint pays zero cost when the client isn't using
    // idempotency (e.g. admin CLI scripts, legacy clients).
    return handler();
  }

  // Canonical-order JSON so two equivalent bodies with reordered
  // keys hash to the same value. Without this, a client that sends
  // `{"a":1,"b":2}` on the first try and `{"b":2,"a":1}` on the
  // retry would trigger a false `idempotency_mismatch`.
  const bodyString = stableStringify(input.body ?? null);

  const lookup = await lookupIdempotencyKey({
    db: input.ctx.db,
    endpoint: input.endpoint,
    subject: input.subject,
    key: rawKey,
    requestBody: bodyString,
    now: input.ctx.now,
  });

  if (lookup.status === 'hit') {
    return lookup.response;
  }
  if (lookup.status === 'mismatch') {
    return idempotencyMismatchResponse(input.ctx.requestId);
  }
  if (lookup.status === 'in_progress') {
    return idempotencyInProgressResponse(input.ctx.requestId);
  }

  // `first_seen` — WE atomically claimed the slot. The pending row
  // is in the DB with response_status=0; any concurrent retry is
  // blocked on it until we call `storeIdempotencyKey` to commit the
  // real response. Run the handler now.
  //
  // If the handler throws we MUST clear the claim row so a retry
  // can reclaim immediately — otherwise the pending row hangs until
  // its CLAIM_TTL expires. The finally-block deletes the pending
  // row on throw; success path replaces it via store's ON CONFLICT
  // DO UPDATE.
  let response: NextResponse;
  try {
    response = await handler();
  } catch (err) {
    // Release the claim so the next retry is not blocked on a
    // stuck pending row. Best-effort — if the release itself fails,
    // the row will expire after CLAIM_TTL anyway.
    await releaseClaim(input).catch(() => {});
    throw err;
  }

  // Clone so both we (to read text for persistence) and Next.js
  // (to send the response to the client) can consume the body
  // independently — the Web API guarantees clone() produces two
  // independently-readable body streams.
  const clone = response.clone();
  const responseBodyText = await clone.text();

  // `storeIdempotencyKey` internally filters non-cacheable statuses
  // (5xx etc.) so a transient failure does not poison the cache. For
  // non-cacheable statuses the pending row is left in place and will
  // expire after CLAIM_TTL — a retry then re-runs the handler, which
  // is what we want for transient errors.
  await storeIdempotencyKey({
    db: input.ctx.db,
    endpoint: input.endpoint,
    subject: input.subject,
    key: rawKey,
    requestBody: bodyString,
    responseStatus: response.status,
    responseBody: responseBodyText,
    now: input.ctx.now,
  });

  return response;
}

/**
 * Deterministic JSON stringifier — sorts object keys at every depth
 * so `{a, b}` and `{b, a}` stringify identically. Arrays keep their
 * index order (semantically meaningful). Non-object primitives use
 * the standard `JSON.stringify`.
 *
 * This is the canonical form hashed into the idempotency key's
 * `request_hash` field. Two bodies that differ only in key ordering
 * will produce the same hash and be treated as the same request on
 * replay.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableStringify(v)}`;
  });
  return `{${parts.join(',')}}`;
}

/**
 * Release a claim by deleting the pending row. Called on handler
 * throw so a retry can re-claim immediately instead of waiting for
 * the claim TTL to expire.
 */
async function releaseClaim(input: WithIdempotencyInput): Promise<void> {
  const { createHash } = await import('node:crypto');
  const rawKey = extractIdempotencyKey(input.ctx.request);
  if (rawKey === null) return;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const { sql } = await import('drizzle-orm');
  await input.ctx.db.execute(
    sql`DELETE FROM idempotency_keys
         WHERE subject_kind = ${input.subject.kind}
           AND subject_id = ${input.subject.id}
           AND endpoint = ${input.endpoint}
           AND key_hash = ${keyHash}
           AND response_status = 0`,
  );
}
