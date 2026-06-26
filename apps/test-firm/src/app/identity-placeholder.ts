/**
 * Fallback rendering helpers for the test-firm dashboard's pre-link
 * profile card — used only when a firm user predates the registration
 * `displayName` field (older persisted snapshots set `displayName` to
 * `null`). Newer registrations carry a real name; the dashboard
 * prefers that and only falls back to these helpers when the field
 * is absent.
 *
 *   * `deriveAvatarInitials(email)` — initials for the avatar disc
 *     when no real display name is available yet.
 *
 *   * `deriveDisplayName(email)` — humane Title-Case rendering of
 *     the email's local-part.
 *
 * Pure helpers — no state, no IO. Safe to import from server
 * components.
 */

/**
 * Derive the two-letter avatar initials from an email address. Falls
 * back to a single character when the local part is a single token
 * (e.g. `flydev` → `F`), and to `??` when the address is malformed.
 */
export function deriveAvatarInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  if (local.length === 0) return '??';
  const tokens = local
    .split(/[._\-+]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length >= 2) {
    return `${tokens[0]![0]!}${tokens[1]![0]!}`.toUpperCase();
  }
  return local[0]!.toUpperCase();
}

/**
 * Humane display name from an email's local part. Splits on
 * separators and Title-Cases each token so `john.doe@x.com` →
 * `John Doe`, `flydev@x.com` → `Flydev`.
 */
export function deriveDisplayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  if (local.length === 0) return email;
  return local
    .split(/[._\-+]/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}
