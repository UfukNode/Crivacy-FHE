/**
 * TOTP recovery-code primitives.
 *
 * Recovery codes are the backup-path for firm users who've lost access
 * to their authenticator app. Design notes:
 *
 *   - **Format**: 10 hex characters, dash-grouped as `XXXXX-XXXXX`
 *     (40 bits of entropy per code). GitHub uses the same shape; the
 *     dash is cosmetic and stripped before hashing so the user can
 *     paste the code with or without it.
 *   - **Storage**: only the SHA-256 hash of the normalised code lives
 *     in the DB. The raw value is surfaced to the user exactly once
 *     in the API response and never again. A DB leak cannot be
 *     replayed.
 *   - **Normalisation**: dashes and whitespace are stripped; letters
 *     are upper-cased. That way `a1b2c-3d4e5`, `A1B2C-3D4E5`, and
 *     `A1B2C3D4E5` all hash identically — small mercy for users who
 *     are already stressed because they've lost their phone.
 *
 * Consumed by:
 *   - `handleAcceptFirmInvite` (enrolment)
 *   - the recovery-code redemption endpoint (login step-up)
 *   - the regenerate endpoint (settings/security)
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';

/** How many codes are issued per batch. Matches industry standard (GitHub = 16, Stripe = 10; eight is the middle ground that fits on a single printable card). */
export const RECOVERY_CODE_BATCH_SIZE = 8;

/**
 * Generate one recovery code. 5 bytes of CSPRNG entropy rendered as
 * 10 uppercase hex characters, formatted `XXXXX-XXXXX`.
 */
export function generateRecoveryCode(): string {
  const raw = randomBytes(5).toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Strip dashes + whitespace and upper-case so the same physical code
 * hashes identically whether the user types it with or without the
 * separator. Callers MUST normalise before hashing or comparing.
 */
export function normaliseRecoveryCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * SHA-256 hex digest of the normalised code. Matches the pattern used
 * by {@link generateInviteToken}/{@link hashInviteToken} so there's
 * one hashing story across single-use tokens.
 */
export function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(raw)).digest('hex');
}

/**
 * Produce a full batch — raw codes + their hashes — so the caller can
 * return the raw values in the API response and persist only the
 * hashes. Zip-shaped output avoids the risk that one array drifts out
 * of alignment with the other.
 */
export function generateRecoveryCodeBatch(
  count: number = RECOVERY_CODE_BATCH_SIZE,
): ReadonlyArray<{ readonly raw: string; readonly hash: string }> {
  const codes: Array<{ raw: string; hash: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const raw = generateRecoveryCode();
    codes.push({ raw, hash: hashRecoveryCode(raw) });
  }
  return codes;
}
