/**
 * Registered subscribers for the security-events outbox.
 *
 * Each subscriber consumes the same event envelope but performs a
 * different side effect:
 *
 *   - `auditSubscriber` — writes the canonical audit-log row for
 *     the event. Replaces the inline `writeAudit(...)` calls that
 *     used to live at the end of every state-changing handler.
 *
 *   - `emailSubscriber` — enqueues the out-of-band notification
 *     email (e.g. "your password was changed"). Replaces the inline
 *     `dispatchPasswordChangedAlert(...)` calls.
 *
 * Idempotency posture — at-least-once. The dispatcher marks events
 * processed AFTER subscriber success, so a worker crash between
 * subscriber return and the `processed_at` stamp can re-fire the
 * same event on the next poll. Result: an extra audit row / a
 * duplicate notification email in that rare window. A later pass
 * will add an `event_id` UNIQUE key on audit + a per-user-per-event
 * dedupe table for emails to harden this to exactly-once; for now
 * the occasional duplicate is the accepted tradeoff for moving
 * audit + email into the same transaction as the state change.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import { customerActor, systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { noTarget, uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { AuditAction } from '@/lib/audit/actions';
import { dispatchPasswordChangedAlert } from '@/lib/auth/password-changed-alert';
import { detectUniqueViolation } from '@/lib/db/unique-violation';
import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import {
  accountLockedEmail,
  emailChangedNotificationEmail,
  linkedAccountChangedEmail,
  recoveryCodesRegeneratedEmail,
  sessionReuseDetectedEmail,
  totpChangedEmail,
} from '@/lib/email/templates';
import { getAppUrl } from '@/lib/env/app-url';

import type { SecurityEventEnvelope, SubscriberContext } from './dispatcher';
import type { EventSubjectKind, SecurityEventType } from './emit';
import {
  AccountLockedEventPayload,
  EmailAddedEventPayload,
  EmailChangedEventPayload,
  LinkedAccountEventPayload,
  PasswordChangeEventPayload,
  SessionReuseDetectedEventPayload,
  TotpEventPayload,
} from './payload';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map an event type to the audit `action` string it should emit.
 * Events that don't have a dedicated audit entry (yet) map to
 * `null` so the audit subscriber can skip them without throwing.
 */
function auditActionForEvent(eventType: SecurityEventType): AuditAction | null {
  switch (eventType) {
    case 'customer.password_changed':
      return 'customer.password_changed';
    case 'customer.password_set':
      return 'customer.password_set';
    case 'customer.password_reset':
      return 'customer.password_reset_completed';
    case 'firm_user.password_changed':
      return 'firm_user.password_changed';
    case 'firm_user.password_reset':
      return 'firm_user.password_reset_completed';
    case 'admin_user.password_changed':
      return 'admin_user.password_changed';
    case 'firm_user.totp_enabled':
      return 'firm_user.totp_enabled';
    case 'firm_user.totp_disabled':
      return 'firm_user.totp_disabled';
    case 'firm_user.recovery_codes_regenerated':
      return 'firm_user.recovery_codes_regenerated';
    case 'admin_user.totp_enabled':
      return 'admin_user.totp_enabled';
    case 'admin_user.totp_disabled':
      return 'admin_user.totp_disabled';
    case 'admin_user.recovery_codes_regenerated':
      return 'admin_user.recovery_codes_regenerated';
    case 'customer.email_changed':
      return 'customer.email_changed';
    case 'customer.email_added':
      return 'customer.email_added';
    // Account-locked + linked-account families: the canonical audit
    // row is written inline at the emit callsite (login.failed +
    // meta.reason='*_locked_now' for lockout; customer.{google,wallet}
    // _{linked,unlinked} writeAudit at the link/unlink routes). The
    // outbox event exists only to drive the email subscriber — having
    // the audit subscriber write a second row would duplicate forensic
    // data, so we explicitly skip it here.
    case 'customer.account_locked':
    case 'firm_user.account_locked':
    case 'admin_user.account_locked':
    case 'customer.google_linked':
    case 'customer.google_unlinked':
    case 'customer.wallet_linked':
    case 'customer.wallet_unlinked':
    // Token-family revoke / refresh-token reuse-detection family —
    // the canonical audit row (`<aud>.session.reuse_detected`) is
    // written inline at the refresh route stale-replay branch
    // alongside the `revoked_at` UPDATE (Pattern A-in-tx). Letting
    // the audit subscriber write a second row would duplicate
    // forensic data, so this family routes through the email
    // subscriber only — same posture as account_locked + linked-
    // account families.
    case 'customer.session_reuse_detected':
    case 'firm_user.session_reuse_detected':
    case 'admin_user.session_reuse_detected':
      return null;
    // Events that don't yet have a dedicated audit entry return null.
    // The subscriber treats that as an explicit skip, not a missing
    // branch — adding a new event type requires adding its action
    // here OR accepting that it won't be audited through this path.
    default:
      return null;
  }
}

/**
 * Which payload shape a given event type uses. Drives the audit
 * subscriber's meta-building switch so each event family stores
 * the data the corresponding audit row needs.
 */
type EventFamily = 'password' | 'totp' | 'email_changed' | 'email_added';

function familyForEvent(eventType: SecurityEventType): EventFamily | null {
  switch (eventType) {
    case 'customer.password_changed':
    case 'customer.password_set':
    case 'customer.password_reset':
    case 'firm_user.password_changed':
    case 'firm_user.password_reset':
    case 'admin_user.password_changed':
      return 'password';
    case 'firm_user.totp_enabled':
    case 'firm_user.totp_disabled':
    case 'firm_user.recovery_codes_regenerated':
    case 'admin_user.totp_enabled':
    case 'admin_user.totp_disabled':
    case 'admin_user.recovery_codes_regenerated':
      return 'totp';
    case 'customer.email_changed':
      return 'email_changed';
    case 'customer.email_added':
      return 'email_added';
    default:
      return null;
  }
}

/**
 * Map subject kind to the audience string {@link dispatchPasswordChangedAlert}
 * expects. Admin / firm / customer happen to line up 1:1 today.
 */
function audienceForSubjectKind(
  kind: 'customer' | 'firm_user' | 'admin_user',
): 'customer' | 'firm' | 'admin' {
  if (kind === 'customer') return 'customer';
  if (kind === 'firm_user') return 'firm';
  return 'admin';
}

/* -------------------------------------------------------------------------- */
/*  Audit subscriber                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Actor factory shared across families. For customer-subject events
 * the pre-migration pattern used `customerActor` with a label; other
 * audiences used `systemActor('firm-auth'/'admin-auth')`. Preserving
 * the inline contract means audit queries that project on actor kind
 * keep working unchanged.
 */
function actorForSubject(
  kind: 'customer' | 'firm_user' | 'admin_user',
  subjectId: string,
  payloadEmail: string | null,
) {
  if (kind === 'customer') {
    // customerActor label falls back to the subject id when email is
    // null (wallet-only users) — matches the historical inline call.
    const label = payloadEmail ?? `wallet:${subjectId.slice(0, 8)}`;
    return customerActor({ id: subjectId, label });
  }
  return systemActor(kind === 'firm_user' ? 'firm-auth' : 'admin-auth');
}

/**
 * Audit-trail subscriber. Skips events that do not have a mapped
 * audit action; otherwise writes the standard audit row with the
 * event's `emittedAt` as the canonical timestamp. Meta shape varies
 * per family — Zod parses the corresponding schema before use.
 */
export async function auditSubscriber(
  event: SecurityEventEnvelope,
  ctx: SubscriberContext,
): Promise<void> {
  const action = auditActionForEvent(event.eventType);
  if (action === null) return;
  const family = familyForEvent(event.eventType);
  if (family === null) return;

  const target =
    event.subject.kind === 'customer'
      ? noTarget()
      : uuidTarget({ kind: event.subject.kind, id: event.subject.id });

  let auditCtxPayload;
  let meta: Record<string, unknown>;
  let actorEmail: string | null = null;

  switch (family) {
    case 'password': {
      const payload = PasswordChangeEventPayload.parse(event.payload);
      auditCtxPayload = payload.auditContext;
      actorEmail = payload.email;
      meta = { sessionId: payload.sessionId, reason: payload.reason };
      break;
    }
    case 'totp': {
      const payload = TotpEventPayload.parse(event.payload);
      auditCtxPayload = payload.auditContext;
      meta = {
        reason: payload.reason,
        ...(payload.factor !== undefined ? { factor: payload.factor } : {}),
      };
      break;
    }
    case 'email_changed': {
      const payload = EmailChangedEventPayload.parse(event.payload);
      auditCtxPayload = payload.auditContext;
      actorEmail = payload.newEmail;
      meta = { oldEmail: payload.oldEmail, newEmail: payload.newEmail };
      break;
    }
    case 'email_added': {
      const payload = EmailAddedEventPayload.parse(event.payload);
      auditCtxPayload = payload.auditContext;
      actorEmail = payload.email;
      meta = { email: payload.email, outcome: payload.outcome };
      break;
    }
  }

  const auditCtx = buildAuditRequestContext(auditCtxPayload);

  try {
    await writeAudit(ctx.db, {
      action,
      actor: actorForSubject(event.subject.kind, event.subject.id, actorEmail),
      target,
      context: auditCtx,
      meta,
      ts: event.emittedAt,
      // Dedup key — audit_log has a partial unique index on
      // `event_id`; a worker retry that re-fires this subscriber
      // against the same outbox row hits 23505 and we silently
      // succeed. The row written by the first attempt is the source
      // of truth.
      eventId: event.id,
    });
  } catch (err) {
    const violation = detectUniqueViolation(err);
    if (violation !== null && violation.constraint === 'audit_log_event_id_unique') {
      // Idempotent replay — audit row for this event already exists.
      return;
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Email subscriber                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Transactional-email subscriber. Dispatches the correct out-of-band
 * notification for each event family:
 *
 *   - password family → `dispatchPasswordChangedAlert` (unchanged).
 *   - `customer.email_changed` → notify the OLD address so the
 *     real account owner sees "your email was moved to X" even if
 *     the rotation was attacker-driven.
 *
 * Events without a notification email (TOTP family, email_added —
 * those have their own branch logic) just return without touching
 * the email transport.
 */
export async function emailSubscriber(
  event: SecurityEventEnvelope,
  ctx: SubscriberContext,
): Promise<void> {
  // Password-family → existing alert dispatcher.
  const isPasswordEvent =
    event.eventType === 'customer.password_changed' ||
    event.eventType === 'customer.password_set' ||
    event.eventType === 'customer.password_reset' ||
    event.eventType === 'firm_user.password_changed' ||
    event.eventType === 'firm_user.password_reset' ||
    event.eventType === 'admin_user.password_changed';

  if (isPasswordEvent) {
    const payload = PasswordChangeEventPayload.parse(event.payload);
    await dispatchPasswordChangedAlert({
      db: ctx.db,
      audience: audienceForSubjectKind(event.subject.kind),
      userId: event.subject.id,
      email: payload.email,
      displayName: payload.displayName,
      ip: payload.auditContext.ip,
      now: event.emittedAt,
      securityUrlPath: payload.securityUrlPath,
      reason: payload.reason,
    });
    return;
  }

  // Email-change → notify the OLD address. The new address does
  // not get a notification (it already verified the 6-digit code in
  // the pre-commit step, so it knows it received the change).
  if (event.eventType === 'customer.email_changed') {
    const payload = EmailChangedEventPayload.parse(event.payload);
    if (payload.oldEmail === null) return;
    const securityUrl = `${getAppUrl()}/settings/security`;
    const content = emailChangedNotificationEmail({
      displayName: payload.displayName,
      oldEmail: payload.oldEmail,
      newEmail: payload.newEmail,
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: payload.oldEmail,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  // TOTP family + recovery_codes_regenerated — emit-time payload
  // does not carry recipient identity (see note on TotpEventPayload),
  // so resolve email + displayName via a single SELECT keyed on the
  // subject. The audience suffix on the event type carries the kind
  // already, so the lookup is unambiguous.
  if (
    event.eventType === 'firm_user.totp_enabled' ||
    event.eventType === 'firm_user.totp_disabled' ||
    event.eventType === 'admin_user.totp_enabled' ||
    event.eventType === 'admin_user.totp_disabled'
  ) {
    const payload = TotpEventPayload.parse(event.payload);
    const recipient = await resolveRecipient(ctx, event.subject.kind, event.subject.id);
    if (recipient === null) return;
    const audience: 'firm' | 'admin' =
      event.subject.kind === 'firm_user' ? 'firm' : 'admin';
    const eventKind: 'enrolled' | 'replaced' | 'disabled' =
      event.eventType.endsWith('disabled')
        ? 'disabled'
        : payload.reason === 'replaced' || payload.reason === 'totp_replaced'
          ? 'replaced'
          : 'enrolled';
    const securityUrl = `${getAppUrl()}${audience === 'firm' ? '/dashboard/settings/security' : '/admin/settings/security'}`;
    const content = totpChangedEmail({
      displayName: recipient.displayName,
      audience,
      eventKind,
      timestamp: event.emittedAt.toISOString(),
      ipAddress: payload.auditContext.ip ?? 'unknown',
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: recipient.email,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  if (
    event.eventType === 'firm_user.recovery_codes_regenerated' ||
    event.eventType === 'admin_user.recovery_codes_regenerated'
  ) {
    const payload = TotpEventPayload.parse(event.payload);
    const recipient = await resolveRecipient(ctx, event.subject.kind, event.subject.id);
    if (recipient === null) return;
    const audience: 'firm' | 'admin' =
      event.subject.kind === 'firm_user' ? 'firm' : 'admin';
    const securityUrl = `${getAppUrl()}${audience === 'firm' ? '/dashboard/settings/security' : '/admin/settings/security'}`;
    const content = recoveryCodesRegeneratedEmail({
      displayName: recipient.displayName,
      audience,
      timestamp: event.emittedAt.toISOString(),
      ipAddress: payload.auditContext.ip ?? 'unknown',
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: recipient.email,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  // Account-locked family — payload snapshot already carries the
  // recipient identity at emit time; no DB lookup needed. The audit
  // row is already on disk via the inline writeAudit at the
  // threshold-crossing site, so the only remaining duty here is the
  // email leg.
  if (
    event.eventType === 'customer.account_locked' ||
    event.eventType === 'firm_user.account_locked' ||
    event.eventType === 'admin_user.account_locked'
  ) {
    const payload = AccountLockedEventPayload.parse(event.payload);
    const audience: 'customer' | 'firm' | 'admin' =
      event.subject.kind === 'customer'
        ? 'customer'
        : event.subject.kind === 'firm_user'
          ? 'firm'
          : 'admin';
    const securityUrl = `${getAppUrl()}${
      audience === 'customer'
        ? '/settings/security'
        : audience === 'firm'
          ? '/dashboard/settings/security'
          : '/admin/settings/security'
    }`;
    const content = accountLockedEmail({
      displayName: payload.displayName,
      audience,
      ipAddress: payload.auditContext.ip ?? 'unknown',
      lockedUntil: payload.lockedUntil,
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: payload.email,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  // Linked-account family — payload carries recipient + provider +
  // eventKind; subscriber just renders + enqueues.
  if (
    event.eventType === 'customer.google_linked' ||
    event.eventType === 'customer.google_unlinked' ||
    event.eventType === 'customer.wallet_linked' ||
    event.eventType === 'customer.wallet_unlinked'
  ) {
    const payload = LinkedAccountEventPayload.parse(event.payload);
    const securityUrl = `${getAppUrl()}/settings/security`;
    const content = linkedAccountChangedEmail({
      displayName: payload.displayName,
      provider: payload.provider,
      eventKind: payload.eventKind,
      timestamp: event.emittedAt.toISOString(),
      ipAddress: payload.auditContext.ip ?? 'unknown',
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: payload.email,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  // Token-family revoke / refresh-token reuse-detection — payload
  // carries recipient + sessionId; subscriber renders the
  // "suspicious activity, please sign in again" notice + enqueues.
  // Audit row already on disk via inline writeAudit at the refresh
  // route stale-replay branch (Pattern A-in-tx).
  if (
    event.eventType === 'customer.session_reuse_detected' ||
    event.eventType === 'firm_user.session_reuse_detected' ||
    event.eventType === 'admin_user.session_reuse_detected'
  ) {
    const payload = SessionReuseDetectedEventPayload.parse(event.payload);
    const audience: 'customer' | 'firm' | 'admin' =
      event.subject.kind === 'customer'
        ? 'customer'
        : event.subject.kind === 'firm_user'
          ? 'firm'
          : 'admin';
    const securityUrl = `${getAppUrl()}${
      audience === 'customer'
        ? '/settings/security'
        : audience === 'firm'
          ? '/dashboard/settings/security'
          : '/admin/settings/security'
    }`;
    const content = sessionReuseDetectedEmail({
      displayName: payload.displayName,
      timestamp: event.emittedAt.toISOString(),
      ipAddress: payload.auditContext.ip ?? 'unknown',
      securityUrl,
    });
    await enqueueEmailFromRoute(ctx.db, {
      to: payload.email,
      content,
      emailType: 'notification',
      userId: event.subject.id,
    });
    return;
  }

  // Other event families (email_added) have no audited email
  // notification on this path — return silently.
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface ResolvedRecipient {
  readonly email: string;
  readonly displayName: string;
}

/**
 * Look up the email + displayName for a subject so the email
 * subscriber can render templates that need them but whose emit
 * payload does not embed them (TOTP family, recovery_codes_*).
 *
 * Returns `null` when the row is gone (deleted account, race) so the
 * subscriber can short-circuit silently — losing a TOTP-changed email
 * for a customer who just deleted their account is a benign outcome,
 * not an error.
 */
async function resolveRecipient(
  ctx: SubscriberContext,
  kind: EventSubjectKind,
  id: string,
): Promise<ResolvedRecipient | null> {
  if (kind === 'firm_user') {
    const result = await ctx.db.execute<{ email: string; display_name: string | null }>(
      sql`SELECT email, display_name FROM firm_users WHERE id = ${id} LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      email: row.email,
      displayName: row.display_name ?? row.email.split('@')[0] ?? 'there',
    };
  }
  if (kind === 'admin_user') {
    const result = await ctx.db.execute<{ email: string; display_name: string | null }>(
      sql`SELECT email, display_name FROM admin_users WHERE id = ${id} LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      email: row.email,
      displayName: row.display_name ?? row.email.split('@')[0] ?? 'there',
    };
  }
  // customer
  const result = await ctx.db.execute<{ email: string | null; display_name: string | null }>(
    sql`SELECT email, display_name FROM customers WHERE id = ${id} LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined || row.email === null) return null;
  return {
    email: row.email,
    displayName: row.display_name ?? row.email.split('@')[0] ?? 'there',
  };
}
