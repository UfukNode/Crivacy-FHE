/**
 * Wiring layer between `evaluateFaceMatch` (pure) and the database
 * (DI'd). Sprint 6's face-match evaluator is a pure function that
 * receives match metadata and an account-status lookup; the wiring
 * here is the production implementation of that lookup.
 *
 * Resolution rules:
 *   - `vendor_data.type === 'customer'` → query `customers` for the
 *     matched customer id; project status + email. `banned` → cascade
 *     trigger; everything else (`active` / `locked` / `suspended` /
 *     `pending_verification`) → clean (block_toast). This treats
 *     locked/suspended as "not the same user, not a fraudster" — the
 *     toast UX is identical to scenario 2 and we deliberately don't
 *     leak the matched account's actual status to the attempter.
 *   - `vendor_data.type === 'b2b'` → no customer record to look up
 *     (B2B sessions have no first-class user account); always returns
 *     `b2b_only`.
 *   - Unparseable / unknown vendor_data → returns `unknown`. The
 *     evaluator skips these from cascade decisions; the webhook
 *     handler logs them so ops can investigate (Didit shipped a new
 *     vendor_data shape).
 *
 * Order preservation: the returned array maps 1:1 to the input
 * matches array — index N out maps to index N in. The evaluator's
 * worst-case rule walks the array positionally to pick the most-
 * recent toast target.
 *
 * @module
 */

import { inArray } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

import {
  parseMatchVendorData,
  type FaceMatchLookup,
  type MatchedAccountStatus,
  type ResolvedMatch,
} from './face-match';
import type { DiditMatchEntry } from '@crivacy-fhe/adapter-didit/types';

/**
 * Build a production `FaceMatchLookup` bound to the provided database
 * handle. Each `resolveMatches` call issues at most ONE batched query
 * against `customers` (covering every customer-typed match in the
 * input), so the evaluator's per-cascade DB cost is O(1) regardless
 * of how many matches Didit returned.
 */
export function createFaceMatchLookup(db: CrivacyDatabase): FaceMatchLookup {
  return {
    async resolveMatches(matches: readonly DiditMatchEntry[]): Promise<readonly ResolvedMatch[]> {
      if (matches.length === 0) return [];

      // Pass 1 — parse vendor_data on every match. Side-by-side with
      // the input so we can reuse the parsed shape in pass 3 without
      // re-running JSON.parse.
      const parsed = matches.map((m) => parseMatchVendorData(m.vendorData));

      // Pass 2 — collect the set of customer ids we need to look up.
      const customerIds = new Set<string>();
      for (const p of parsed) {
        if (p !== null && p.type === 'customer') customerIds.add(p.customerId);
      }

      // Single batched read. Empty set → skip the query.
      const customerRows = customerIds.size > 0
        ? await db
            .select({
              id: schema.customers.id,
              status: schema.customers.status,
              email: schema.customers.email,
              deletedAt: schema.customers.deletedAt,
            })
            .from(schema.customers)
            .where(inArray(schema.customers.id, Array.from(customerIds)))
        : [];

      const customerById = new Map<
        string,
        { status: string; email: string | null; deletedAt: Date | null }
      >();
      for (const row of customerRows) {
        customerById.set(row.id, {
          status: row.status,
          email: row.email,
          deletedAt: row.deletedAt,
        });
      }

      // Pass 3 — combine parsed + lookup into the resolved array.
      // Order is preserved (map 1:1 over input).
      return matches.map((match, idx): ResolvedMatch => {
        const p = parsed[idx] ?? null;
        if (p === null) return { match, status: { kind: 'unknown' } };

        if (p.type === 'b2b') {
          return {
            match,
            status: {
              kind: 'b2b_only',
              firmId: p.firmId,
              userRef: p.userRef,
            },
          };
        }

        // Customer flow — derive status from the looked-up row.
        const customerId = p.customerId;
        const row = customerById.get(customerId);
        if (row === undefined || row.deletedAt !== null) {
          // Row missing (race / hard-deleted / GDPR purged) → treat
          // as unknown so the evaluator does NOT cascade. The
          // matched session existed in Didit but the account is
          // gone on our side; the right answer is "no engel".
          return { match, status: { kind: 'unknown' } };
        }

        const status: MatchedAccountStatus =
          row.status === 'banned'
            ? { kind: 'customer_banned', customerId, email: row.email }
            : { kind: 'customer_clean', customerId, email: row.email };

        return { match, status };
      });
    },
  };
}

/**
 * Stable narrow that `evaluateFaceMatch`'s `lookup` field expects.
 * Exported as a re-export so callers don't have to know the lookup
 * comes from this file vs face-match.ts.
 */
export type { FaceMatchLookup, ResolvedMatch } from './face-match';

/**
 * Convenience query — does the blacklist hold a face_hash row that
 * matches ANY of the supplied Didit session ids? Used by the webhook
 * handler to detect cascade BEFORE the evaluator runs (`face_hash`
 * is the only signal that survives a pre-Sprint-6 ban that lacked
 * the cascade infrastructure). Wraps `isFaceBlacklisted` for the
 * batch case.
 */
export async function findCascadeMatchByFaceHash(
  db: CrivacyDatabase,
  matches: readonly DiditMatchEntry[],
): Promise<DiditMatchEntry | null> {
  if (matches.length === 0) return null;
  const { hashFace } = await import('./blacklist');
  const hashes = matches.map((m) => hashFace(m.sessionId));

  const rows = await db
    .select({ faceHash: schema.customerBlacklist.faceHash })
    .from(schema.customerBlacklist)
    .where(inArray(schema.customerBlacklist.faceHash, hashes));

  if (rows.length === 0) return null;
  const hitSet = new Set<string>();
  for (const r of rows) {
    if (r.faceHash !== null) hitSet.add(r.faceHash);
  }
  for (const m of matches) {
    if (hitSet.has(hashFace(m.sessionId))) return m;
  }
  return null;
}
