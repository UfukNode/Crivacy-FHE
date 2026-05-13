/**
 * Firm-facing ticket limits that scale with subscription tier.
 *
 * We keep the table here (not inline in handlers) so the same mapping
 * drives:
 *   - the `handleCreateFirmTicket` open-ticket guard
 *   - any future dashboard UI hint ("you have 3 / 5 open tickets")
 *   - tests
 *
 * Changing a tier's cap is a one-line edit with no scattered
 * constants to hunt down.
 *
 * @module
 */

/** Shape the DB enum expects. Matches `firmTierEnum`. */
export type FirmTier = 'free' | 'starter' | 'pro' | 'enterprise';

/**
 * Concurrent open-ticket cap per firm, keyed by tier. "Open" means
 * status ∈ (open, in_progress, waiting_customer). Closed / resolved
 * tickets don't count against the cap — the firm can revisit them
 * and open new work any time.
 *
 * Values mirror the disclosure-API tier table (basic:30/dk →
 * pro:120/dk → ent:600/dk) in spirit: premium tiers get more
 * breathing room, not a free-for-all.
 */
export const FIRM_OPEN_TICKET_LIMIT: Readonly<Record<FirmTier, number>> = Object.freeze({
  free: 1,
  starter: 2,
  pro: 5,
  enterprise: 20,
});

/** Safe accessor with a conservative fallback for unknown tiers. */
export function getFirmOpenTicketLimit(tier: string): number {
  if (tier in FIRM_OPEN_TICKET_LIMIT) {
    return FIRM_OPEN_TICKET_LIMIT[tier as FirmTier];
  }
  return FIRM_OPEN_TICKET_LIMIT.free;
}
