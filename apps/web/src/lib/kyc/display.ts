/**
 * KYC display helpers — single source of truth for the visual mapping
 * of customer KYC level / credential level / KYC score onto the
 * shared `StatusBadge` palette. Imported by every surface that
 * renders these primitives (admin customer list, admin customer
 * detail, future customer self-service surfaces) so an "Enhanced"
 * pill is the same colour everywhere.
 *
 * Why a dedicated module:
 *   - Three palette decisions are made once here and re-used: KYC
 *     level pill, credential level pill, and score-band colouring.
 *   - The customer's `kyc_2` (Identity-verified) and the credential's
 *     `basic` row mean the same thing semantically — both share the
 *     `tier-basic` (sky) variant. Same for `kyc_4` ↔ `enhanced`
 *     (`tier-enhanced` violet). Defining the maps separately on each
 *     page risked drift; one page rendered Enhanced as success/green
 *     while the next rendered it as violet.
 *   - Score is a 0–1000 confidence value, not a static badge. A
 *     perfect 1000 read as muted grey on every surface previously,
 *     which made the strongest signal on the page look unimportant.
 *     The band ranges are codified here so any consumer that calls
 *     `scoreVariant` gets the same answer.
 */

export type BadgeVariant =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'tier-basic'
  | 'tier-enhanced';

export interface BadgeMapping {
  readonly variant: BadgeVariant;
  readonly label: string;
}

/**
 * Customer KYC progression palette. `kyc_2` aligns with credential
 * `basic` (sky), `kyc_4` aligns with credential `enhanced` (violet)
 * so the level pill in the customer header agrees with the level
 * pill on the active credential card.
 */
export const KYC_LEVEL_BADGE_MAP: Readonly<Record<string, BadgeMapping>> = Object.freeze({
  kyc_0: { variant: 'neutral', label: 'Unverified' },
  kyc_1: { variant: 'info', label: 'Registered' },
  kyc_2: { variant: 'tier-basic', label: 'Identity' },
  kyc_3: { variant: 'warning', label: 'Biometric' },
  kyc_4: { variant: 'tier-enhanced', label: 'Enhanced' },
});

/**
 * Credential-level pill — keys on the two-value `basic | enhanced`
 * enum used by the credential row. Distinct from KYC level above
 * even though `basic ↔ kyc_2` and `enhanced ↔ kyc_4` share the
 * same colour swatch — different domains, same visual language.
 */
export const CREDENTIAL_LEVEL_BADGE_MAP: Readonly<Record<string, BadgeMapping>> = Object.freeze({
  basic: { variant: 'tier-basic', label: 'Basic' },
  enhanced: { variant: 'tier-enhanced', label: 'Enhanced' },
});

/**
 * Pick a badge / text colour for a 0–1000 KYC score:
 *   - 0      → neutral  (no KYC yet)
 *   - 1–499  → warning  (low confidence)
 *   - 500–799 → info    (mid)
 *   - 800+   → success  (high)
 *
 * The bands intentionally do not perfectly align with `kyc_*`
 * progression — a customer can sit at `kyc_4` with a soft 820 or a
 * perfect 1000, and the colour reflects the score, not the level.
 */
export function scoreVariant(score: number): BadgeVariant {
  if (score <= 0) return 'neutral';
  if (score >= 800) return 'success';
  if (score >= 500) return 'info';
  return 'warning';
}

/**
 * Companion of {@link scoreVariant} for surfaces that render the
 * score as plain text (not a pill) — e.g. a tabular column. Returns
 * a Tailwind text colour class that mirrors the same band logic so
 * a 1000 reads as success-green even without a chip behind it.
 */
export function scoreTextClass(score: number): string {
  if (score <= 0) return 'text-[var(--color-muted)]';
  if (score >= 800) return 'text-[var(--color-success)]';
  if (score >= 500) return 'text-[var(--color-accent)]';
  return 'text-[var(--color-warning)]';
}
