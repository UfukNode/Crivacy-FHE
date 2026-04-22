/**
 * Didit User entity reader.
 *
 * Sprint 8 — KYC address phase name-match anchor.
 *
 * Crivacy's database is PII-clean (Sprint 1 PII purge): we never
 * persist `full_name`, `date_of_birth`, etc. The Didit User entity,
 * however, retains these fields under the `vendor_data` we send on
 * every session create. When we start an address-only session, we
 * need the customer's first/last name to populate
 * `expected_details.{first_name,last_name}` so Didit's PoA name
 * fuzzy match (WRatio) has a reference to compare the OCR'd bill
 * name against. Without those parameters, the bill name check
 * returns NULL and a roommate's utility bill would slip through.
 *
 * This module is the read-only side of that contract:
 *
 *   * `getDiditUser(config, vendorData)` — `GET /v3/users/{vendor_data}/`
 *     returns the User entity or `null` on 404 (entity not yet created).
 *
 *   * `parseFullName(fullName)` — splits "Maria Garcia Lopez" into
 *     `{ firstName: 'Maria Garcia', lastName: 'Lopez' }`. Naive last-
 *     word split: deterministic, fuzzy-match-tolerant. Throws on
 *     single-word or empty input — fail-closed so the address phase
 *     never runs without a usable name anchor.
 *
 * Why the parser is deliberately simple: Didit's WRatio (rapidfuzz)
 * fuzzy match concatenates `expected_first_name + expected_last_name`
 * and compares to the OCR'd `name_on_document` as a single token-
 * normalized string. Where you split the words doesn't affect the
 * concatenated result, so naive split is robust for compound surnames
 * (Spanish, Portuguese, hyphenated names).
 */

import type { z } from 'zod';
import { z as zod } from 'zod';

import type { DiditConfig } from './config';
import { DiditError } from './errors';
import { type FetchLike, diditFetch } from './http';

/* ---------- Schema ---------- */

/**
 * Subset of `GET /v3/users/{vendor_data}/` we read. Didit returns
 * many more fields (status, session counts, features map, comments,
 * etc.) — we only need `full_name` for the name anchor and
 * `didit_internal_id` / `vendor_data` for audit trails.
 *
 * We intentionally use `.passthrough()` (the Zod default for object
 * schemas with extras) so unknown fields don't cause schema
 * validation failures when Didit ships new attributes.
 */
const DiditUserResponseSchema = zod.object({
  vendor_data: zod.string(),
  didit_internal_id: zod.string().optional(),
  full_name: zod.string().nullable().optional(),
  display_name: zod.string().nullable().optional(),
  status: zod.string().optional(),
});

export type DiditUserResponse = z.infer<typeof DiditUserResponseSchema>;

/**
 * Parsed view of the Didit User entity that handlers consume.
 * `fullName` is null when Didit's profile aggregation has not yet
 * picked up an identity-bearing session (e.g. the user only ever
 * had address-only sessions, or the identity session is still in
 * flight).
 */
export interface DiditUser {
  readonly vendorData: string;
  readonly diditInternalId: string | null;
  readonly fullName: string | null;
  readonly status: string | null;
}

/* ---------- Read ---------- */

/**
 * Fetch the Didit User entity for a given `vendor_data`.
 *
 * Returns `null` on 404 (entity has not yet been created — happens
 * when the caller polls before the first session has run, or when
 * the vendor_data was rotated). All other errors propagate as
 * `DiditError` so the caller can decide how to surface them.
 *
 * GET is retried on transient failures by `diditFetch` (5xx,
 * network errors, timeouts).
 */
export async function getDiditUser(
  config: DiditConfig,
  vendorData: string,
  fetchImpl?: FetchLike,
): Promise<DiditUser | null> {
  if (typeof vendorData !== 'string' || vendorData.length === 0) {
    throw new DiditError('invalid_vendor_data', 'vendor_data must be a non-empty string.');
  }
  const path = `/v3/users/${encodeURIComponent(vendorData)}/`;
  let raw: DiditUserResponse;
  try {
    raw = await diditFetch<DiditUserResponse>(
      config,
      {
        method: 'GET',
        path,
        schema: DiditUserResponseSchema,
        context: { vendorData },
      },
      fetchImpl,
    );
  } catch (err) {
    if (err instanceof DiditError && err.code === 'not_found') {
      return null;
    }
    throw err;
  }

  return Object.freeze({
    vendorData: raw.vendor_data,
    diditInternalId: raw.didit_internal_id ?? null,
    fullName: typeof raw.full_name === 'string' && raw.full_name.length > 0 ? raw.full_name : null,
    status: raw.status ?? null,
  });
}

/* ---------- Name parsing ---------- */

/**
 * Result of `parseFullName`. Both fields are guaranteed non-empty
 * because the parser refuses to return a degenerate split.
 */
export interface ParsedName {
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * Split a full name into first/last name halves for the Didit
 * `expected_details` payload.
 *
 * Algorithm: collapse whitespace, split on space, take the **last
 * word** as `lastName`, everything before it as `firstName`. This
 * is the simplest deterministic split that survives compound
 * surnames (Spanish "Maria Garcia Lopez" → first="Maria Garcia",
 * last="Lopez") and middle names ("John Michael Doe" →
 * first="John Michael", last="Doe").
 *
 * Why not parse compound surnames precisely (e.g. detect "Garcia
 * Lopez" as a double surname)? Because Didit's WRatio fuzzy match
 * concatenates expected_first + expected_last and compares the
 * full string to the OCR'd `name_on_document`. The concat is
 * insensitive to where the boundary falls, so a naive split is
 * actually equivalent to a "correct" split for the match itself.
 * Trying to detect compound surnames adds complexity and false-
 * positive risk for zero security gain.
 *
 * Throws `DiditError('invalid_full_name', …)` when:
 *   * Input is empty / non-string after trim
 *   * Input has only one token (e.g. "Madonna") — no last name to
 *     split, name anchor would be incomplete; fail-closed instead
 *     of guessing.
 */
export function parseFullName(fullName: string): ParsedName {
  if (typeof fullName !== 'string') {
    throw new DiditError('invalid_full_name', 'full_name must be a string.');
  }
  const normalized = fullName.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    throw new DiditError('invalid_full_name', 'full_name is empty after normalization.');
  }
  const tokens = normalized.split(' ');
  if (tokens.length < 2) {
    throw new DiditError(
      'invalid_full_name',
      `full_name must have at least 2 tokens for first/last split (got: ${JSON.stringify(normalized)}).`,
    );
  }
  const lastName = tokens[tokens.length - 1] ?? '';
  const firstName = tokens.slice(0, -1).join(' ');
  if (firstName.length === 0 || lastName.length === 0) {
    throw new DiditError(
      'invalid_full_name',
      `full_name parse produced an empty half (first=${JSON.stringify(firstName)}, last=${JSON.stringify(lastName)}).`,
    );
  }
  return Object.freeze({ firstName, lastName });
}
