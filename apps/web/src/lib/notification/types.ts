/**
 * Notification type constants and security event classification.
 *
 * The `NOTIFICATION_TYPES` array defines every valid notification type in the
 * system. Security events (`session.new_device`, `password.changed`) are
 * always delivered regardless of user preferences.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Notification type union
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'kyc.status_changed',
  'kyc.step_completed',
  'credential.issued',
  'credential.revoked',
  'credential.upgraded',
  'ticket.reply',
  'ticket.status_changed',
  'ticket.assigned',
  /** You were invited to collaborate on a ticket (same-level, requires accept/decline). */
  'ticket.invited',
  /** Your pending invite was cancelled by the assignee (or superadmin) before you responded. */
  'ticket.invite_rescinded',
  /** You were directly added to a ticket by a higher-tier admin (no decline). */
  'ticket.added',
  /** You were @mentioned inside a ticket message. Elevated priority over plain reply. */
  'ticket.mentioned',
  /** Your collaborator left the ticket -- delivered to the upper-tier admins on the ticket. */
  'ticket.participant_left',
  /** Fan-out alert: a ticket has no assignee and needs pickup. */
  'ticket.needs_pickup',
  /** Superadmin took over your ticket -- delivered to the displaced assignee. */
  'ticket.taken_over',
  'session.new_device',
  'password.changed',
  'account.status_changed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ---------------------------------------------------------------------------
// Security events — cannot be disabled by user preferences
// ---------------------------------------------------------------------------

export const SECURITY_EVENT_TYPES: readonly NotificationType[] = [
  'session.new_device',
  'password.changed',
  'account.status_changed',
] as const;

/**
 * Check if a notification type is a security event that bypasses
 * user preferences and is always delivered.
 */
export function isSecurityEvent(type: string): boolean {
  return (SECURITY_EVENT_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Notification shape for API responses
// ---------------------------------------------------------------------------

export interface NotificationItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NotificationPreferenceItem {
  readonly eventType: string;
  readonly channelInApp: boolean;
  readonly channelEmail: boolean;
}
