/**
 * Event payload schemas — strict Zod shapes for every
 * {@link SecurityEventType} that has a registered subscriber.
 *
 * Every emit call writes an arbitrary JSONB blob to the outbox; the
 * subscriber reads that blob and parses through the matching schema
 * here. A drift between emit-site and subscriber gets caught at the
 * Zod boundary instead of producing half-dispatched side effects.
 *
 * When adding a new event type:
 *   1. Add it to `SecurityEventType` in `emit.ts`.
 *   2. Add a schema here.
 *   3. Register a subscriber that handles it (or mark it explicitly
 *      as "emit-only, no subscribers yet").
 *
 * @module
 */

import { z } from 'zod';

/**
 * Common audit-trail breadcrumbs captured at emit time so the async
 * subscriber can reconstruct the original request context without
 * looking it up or relying on wall-clock. Mirrors the
 * `buildRequestContext` shape the inline dispatchers consumed.
 */
export const AuditContextPayload = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  // requestId is null when emitted from a code path that does not have
  // a route-bound RequestContext to forward (e.g. customer login
  // failure inside `loginCustomer`, which receives ip/UA via params
  // but no requestId). Existing callers pass a string and parse
  // unchanged.
  requestId: z.string().nullable(),
});

export type AuditContextPayload = z.infer<typeof AuditContextPayload>;

/**
 * Shape every `*.password_changed` / `*.password_set` /
 * `*.password_reset` event must carry. Subscribers key on this
 * exact shape — a field rename is a breaking change and requires
 * the event's `eventVersion` to bump.
 *
 * The `sessionId` field is nullable because reset-password flows
 * mint a brand-new session rather than reusing one (the old
 * session just got revoked as part of the reset), and the emit
 * site genuinely has no session id to record.
 */
export const PasswordChangeEventPayload = z.object({
  auditContext: AuditContextPayload,
  /** Session the mutation ran under; null on reset-password flows. */
  sessionId: z.string().nullable(),
  /** The email we should notify, if the account has one on file. */
  email: z.string().nullable(),
  /** Human-readable name shown at the top of the notification email. */
  displayName: z.string(),
  /** Which password-rotation flow triggered this event. */
  reason: z.enum(['changed', 'set', 'reset']),
  /** Per-audience security-settings path for the "review this change" CTA. */
  securityUrlPath: z.string(),
});

export type PasswordChangeEventPayload = z.infer<typeof PasswordChangeEventPayload>;

/* -------------------------------------------------------------------------- */
/*  TOTP family                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Shape every `*.totp_enabled` / `*.totp_disabled` /
 * `*.recovery_codes_regenerated` event carries. The `reason` field
 * discriminates initial enrolment from re-enrolment via replace, and
 * `factor` records which reauth factor was used (useful for triage
 * when a compromised account shows up in the audit log).
 */
export const TotpEventPayload = z.object({
  auditContext: AuditContextPayload,
  /** Human-readable reason that drives the audit row's `meta.reason`. */
  reason: z.enum(['enrolled', 'replaced', 'totp_replaced', 'user_initiated']),
  /**
   * Factor used during reauth. `none` means first-time enrolment
   * (no prior factor required). Absent for `recovery_codes_regenerated`
   * which always requires TOTP.
   */
  factor: z.enum(['none', 'totp', 'recovery_code', 'wallet']).optional(),
});

export type TotpEventPayload = z.infer<typeof TotpEventPayload>;

/* -------------------------------------------------------------------------- */
/*  Email change / add                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `customer.email_changed` — fired after verify-email-change commits
 * the new address. Carries both emails so the audit row shows the
 * rotation and the subscriber can notify the OLD address out-of-band.
 * The old-email notification is what tells a real owner "your email
 * was moved to X" when an attacker with a stolen session tried to
 * pivot.
 */
export const EmailChangedEventPayload = z.object({
  auditContext: AuditContextPayload,
  /** The email the account HAD before the change (null = wallet-only). */
  oldEmail: z.string().nullable(),
  /** The email the account NOW has. */
  newEmail: z.string(),
  /** Display name for the notification template. */
  displayName: z.string(),
});

export type EmailChangedEventPayload = z.infer<typeof EmailChangedEventPayload>;

/**
 * `customer.email_added` — wallet-only customer attached an email
 * for the first time. The `outcome` mirrors the three internal
 * branches of the add-email handler so incident response can tell
 * "attached" apart from "target_taken_notified" /
 * "target_blacklisted_silent" without having to replay the request.
 */
export const EmailAddedEventPayload = z.object({
  auditContext: AuditContextPayload,
  email: z.string(),
  outcome: z.enum(['attached', 'target_taken_notified', 'target_blacklisted_silent']),
});

export type EmailAddedEventPayload = z.infer<typeof EmailAddedEventPayload>;

/* -------------------------------------------------------------------------- */
/*  Account-locked family                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shape every `*.account_locked` event carries. Emitted on the
 * threshold-crossing edge of the failed-login counter; the audit row
 * is already written inline at the same callsite as
 * `<aud>.login.failed + meta.reason='*_locked_now'`, so this event
 * only drives the "your account was locked" email leg.
 *
 * Recipient identity (email + displayName) is snapshotted at emit
 * time so the subscriber does not have to round-trip the row that
 * may meanwhile have been mutated by an admin action. `lockedUntil`
 * is the ISO timestamp where the lock window expires (auto-unlock
 * on next login attempt past this point).
 */
export const AccountLockedEventPayload = z.object({
  auditContext: AuditContextPayload,
  email: z.string(),
  displayName: z.string(),
  /** ISO-8601 — when the lock window expires (auto-unlock boundary). */
  lockedUntil: z.string(),
  /** Which failed-credential leg crossed the threshold. */
  reason: z.enum(['password', 'totp', 'recovery_code']),
});

export type AccountLockedEventPayload = z.infer<typeof AccountLockedEventPayload>;

/* -------------------------------------------------------------------------- */
/*  Linked-account family                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shape every `customer.{google,wallet}_{linked,unlinked}` event
 * carries. Drives the "you linked / unlinked an authentication
 * method" email; the audit row already exists inline at the
 * link/unlink callsite, so the audit subscriber returns null for
 * this family.
 *
 * `provider` + `eventKind` together discriminate the four sub-cases
 * (google add, google remove, wallet add, wallet remove) — the email
 * template selects subject + body copy from this pair.
 */
export const LinkedAccountEventPayload = z.object({
  auditContext: AuditContextPayload,
  email: z.string(),
  displayName: z.string(),
  provider: z.enum(['google', 'wallet']),
  eventKind: z.enum(['added', 'removed']),
});

export type LinkedAccountEventPayload = z.infer<typeof LinkedAccountEventPayload>;

/* -------------------------------------------------------------------------- */
/*  Token-family revoke / refresh-token reuse-detection family                */
/* -------------------------------------------------------------------------- */

/**
 * Shape every `*.session_reuse_detected` event carries (OWASP ASVS
 * V3.5.5 token-family revoke). Emitted inside the same tx as the
 * refresh route stale-replay branch UPDATE that flips `revoked_at`,
 * so the audit + state mutation + email enqueue all roll back together
 * if any leg fails (Pattern A-in-tx).
 *
 * Recipient identity (email + displayName) is snapshotted at emit time
 * so the subscriber does not have to round-trip the user table; ip +
 * userAgent already live in `auditContext` (DRY — no top-level
 * duplication). `sessionId` is the revoked session's UUID for forensic
 * correlation with the SOC dashboard.
 */
export const SessionReuseDetectedEventPayload = z.object({
  auditContext: AuditContextPayload,
  email: z.string(),
  displayName: z.string(),
  /** UUID of the session row that was just revoked. */
  sessionId: z.string(),
});

export type SessionReuseDetectedEventPayload = z.infer<typeof SessionReuseDetectedEventPayload>;
