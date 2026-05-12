/**
 * Ticket @mention parsing helpers.
 *
 * Inline format
 * -------------
 * A mention in a ticket message body is encoded as a literal
 * `@{<uuid>}` token, where `<uuid>` is the mentioned admin user's
 * UUID. Frontend typeaheads render human-readable labels and rewrite
 * the outbound body to this canonical format so the backend never has
 * to disambiguate display-name collisions and renames do not break
 * historical mentions.
 *
 * Example rendered body:
 *
 *   "Hey @{c0ffee00-...} can you take a look?"
 *
 * Rendering on the read side looks up the UUIDs in the admin table
 * and substitutes `@Display Name`. A UUID that no longer resolves
 * falls back to a subdued `@deleted` token in the UI.
 *
 * Allowed targets
 * ---------------
 * The dispatcher further filters mentions to the participant graph;
 * this module only handles raw extraction. See
 * `{@link filterMentionable}` for the admin/scope filter used by
 * the message handlers.
 *
 * @module
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

/**
 * Strict RFC 4122 UUID regex inside the `@{...}` envelope.
 *
 * We use the `g` flag to iterate all matches; the `i` flag keeps the
 * matcher tolerant of uppercase hex letters (PostgreSQL returns
 * lowercase but we should not reject hand-typed uppercase).
 */
const MENTION_PATTERN =
  /@\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi;

/**
 * Extract the set of unique admin UUIDs mentioned inside a message
 * body. Duplicates within the same body collapse. Returns an empty
 * array if the body contains no mentions.
 *
 * The returned UUIDs are lowercased to match the DB representation.
 */
export function parseMentions(body: string): readonly string[] {
  const seen = new Set<string>();
  // `matchAll` is cleaner than a while-loop but allocates; for our
  // 5_000-char bodies the difference is negligible.
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const id = match[1];
    if (id !== undefined) {
      seen.add(id.toLowerCase());
    }
  }
  return Array.from(seen);
}

/**
 * Admin that can actually receive a mention notification on a
 * specific ticket: they must be an active admin (not locked) AND
 * their ticket participant row must be `active`.
 *
 * The intent here is to prevent "tag anyone" behaviour: only people
 * already involved with the ticket can be targeted. The author is
 * always filtered out.
 */
export interface MentionableFilterInput {
  readonly ticketId: string;
  /** Raw mention UUIDs extracted from the message body. */
  readonly candidateIds: readonly string[];
  /** Author of the message -- filtered out even if mentioned. */
  readonly authorId: string;
}

/**
 * Resolve which of the raw `candidateIds` are actually mentionable
 * on this ticket. Non-participants, the author themselves, and
 * locked admins are dropped silently.
 *
 * Returns a fresh array preserving the input order so the downstream
 * audit / notification fan-out is deterministic.
 */
export async function filterMentionable(
  db: CrivacyDatabase,
  input: MentionableFilterInput,
): Promise<readonly string[]> {
  if (input.candidateIds.length === 0) return [];

  const rows = await db
    .select({
      adminUserId: schema.ticketParticipants.adminUserId,
    })
    .from(schema.ticketParticipants)
    .innerJoin(
      schema.adminUsers,
      eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
    )
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, input.ticketId),
        eq(schema.ticketParticipants.status, 'active'),
        isNull(schema.adminUsers.lockedAt),
        inArray(schema.ticketParticipants.adminUserId, [...input.candidateIds]),
      ),
    );

  const allowed = new Set(rows.map((r) => r.adminUserId));
  return input.candidateIds.filter(
    (id) => id !== input.authorId && allowed.has(id),
  );
}

/**
 * Shortcut used by customer follow-up messages: customers may only
 * tag admins that have actually responded on the ticket (active
 * participants), not arbitrary admins.
 */
export async function filterMentionableForCustomer(
  db: CrivacyDatabase,
  ticketId: string,
  candidateIds: readonly string[],
): Promise<readonly string[]> {
  if (candidateIds.length === 0) return [];

  const rows = await db
    .select({
      adminUserId: schema.ticketParticipants.adminUserId,
    })
    .from(schema.ticketParticipants)
    .innerJoin(
      schema.adminUsers,
      eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
    )
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.status, 'active'),
        isNull(schema.adminUsers.lockedAt),
        inArray(schema.ticketParticipants.adminUserId, [...candidateIds]),
      ),
    );

  const allowed = new Set(rows.map((r) => r.adminUserId));
  return candidateIds.filter((id) => allowed.has(id));
}
