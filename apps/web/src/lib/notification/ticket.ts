/**
 * Centralized ticket notifications.
 *
 * Thin wrapper over the central {@link notify} / {@link notifyBulk} dispatcher
 * that encodes the in-app content and email template for every ticket-related
 * event:
 *
 *   - `notifyCustomerTicketReply`          — admin replied → customer
 *   - `notifyCustomerTicketStatusChange`   — status changed → customer
 *   - `notifyAdminNewTicket`               — new customer ticket → admin(s)
 *   - `notifyAdminTicketCustomerReply`     — customer replied → admin(s)
 *   - `notifyAdminTicketAssigned`          — ticket assigned → single admin
 *
 * The helper collapses three concerns into one call: in-app notification,
 * email enqueue, and channel-preference gating. Rate limits, null email
 * handling, and error containment are all delegated to the dispatcher so
 * ticket handlers stay focused on ticket state transitions.
 *
 * Links are built by the caller (we don't own `NEXT_PUBLIC_APP_URL` here);
 * the helper only attaches them verbatim to the in-app notification and
 * email template.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import { ticketUpdateEmail } from '@/lib/email/templates';
import { notify, notifyBulk } from './dispatcher';
import type { NotifyResult, RecipientRef } from './dispatcher';

/* ---------- Shared ticket descriptor ---------- */

/**
 * The subset of ticket fields every notification needs. Callers pass a
 * single object rather than five positional arguments.
 */
export interface TicketDescriptor {
  readonly ticketId: string;
  readonly referenceNumber: string;
  readonly subject: string;
  /**
   * Absolute URL shown in the email CTA. Example for customer:
   * `https://app.crivacy.io/tickets/:id`. Example for admin:
   * `https://app.crivacy.io/admin/tickets/:id`.
   */
  readonly ticketUrl: string;
}

/**
 * Append a `?m=<messageId>` (or `&m=...` if the URL already has a query)
 * so the client can scroll-and-highlight the exact message when the
 * recipient opens the link. No-op when `messageId` is absent so
 * notifications that are not message-specific (assignments, take-over,
 * needs-pickup) pass through unchanged.
 */
function appendMessageDeepLink(url: string, messageId?: string): string {
  if (messageId === undefined || messageId.length === 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}m=${encodeURIComponent(messageId)}`;
}

/* ---------- Customer-facing notifications ---------- */

export interface CustomerTicketReplyInput {
  readonly customerId: string;
  readonly ticket: TicketDescriptor;
  /** Plain-text excerpt of the admin reply, trimmed by the caller. */
  readonly replyPreview: string;
  /**
   * ID of the admin reply that triggered this notification. When
   * present, the customer's ticket page scroll-and-highlights this
   * specific message after navigation. Optional so the helper stays
   * backwards-compatible with legacy callers.
   */
  readonly messageId?: string;
}

/**
 * Admin replied to a ticket — notify the customer who owns it.
 *
 * Routes through `ticket.reply` notification type which respects customer
 * channel preferences (not a security event).
 */
export async function notifyCustomerTicketReply(
  db: CrivacyDatabase,
  input: CustomerTicketReplyInput,
): Promise<NotifyResult> {
  const { ticket, replyPreview, messageId } = input;

  return notify(db, {
    eventType: 'ticket.reply',
    recipient: { type: 'customer', customerId: input.customerId },
    inApp: {
      title: 'New Reply on Your Ticket',
      body: `Your ticket ${ticket.referenceNumber} has a new reply from support.`,
      link: appendMessageDeepLink(`/tickets/${ticket.ticketId}`, messageId),
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message: replyPreview,
          ticketUrl: appendMessageDeepLink(ticket.ticketUrl, messageId),
        }),
    },
  });
}

export interface CustomerTicketStatusChangeInput {
  readonly customerId: string;
  readonly ticket: TicketDescriptor;
  /** New ticket status (e.g. `resolved`, `closed`, `in_progress`). */
  readonly status: string;
  /** Optional note/explanation attached to the status change. */
  readonly note?: string | undefined;
}

/**
 * Ticket status changed — notify the customer who owns it.
 */
export async function notifyCustomerTicketStatusChange(
  db: CrivacyDatabase,
  input: CustomerTicketStatusChangeInput,
): Promise<NotifyResult> {
  const { ticket, status, note } = input;
  const message = note && note.length > 0
    ? `Status changed to ${status}.\n\n${note}`
    : `Status changed to ${status}.`;

  return notify(db, {
    eventType: 'ticket.status_changed',
    recipient: { type: 'customer', customerId: input.customerId },
    inApp: {
      title: 'Ticket Status Updated',
      body: `Your ticket ${ticket.referenceNumber} status changed to ${status}.`,
      link: `/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}

/* ---------- Admin-facing notifications ---------- */

export interface AdminNewTicketInput {
  readonly adminUserIds: readonly string[];
  readonly ticket: TicketDescriptor;
  /** Human label for the ticket author (email or wallet:prefix). */
  readonly customerLabel: string;
  /** Ticket priority at creation time, e.g. `normal`, `high`, `urgent`. */
  readonly priority: string;
}

/**
 * New customer ticket created — fan out to the given admin user IDs.
 *
 * Typical use: `adminUserIds` resolves to all active admins (any role) at
 * the time the ticket is filed. Each recipient is governed independently by
 * their own notification preferences and rate limit.
 */
export async function notifyAdminNewTicket(
  db: CrivacyDatabase,
  input: AdminNewTicketInput,
): Promise<readonly NotifyResult[]> {
  const { ticket, customerLabel, priority } = input;
  const preview = `New ${priority} priority ticket from ${customerLabel}: ${ticket.subject}`;

  const recipients: RecipientRef[] = input.adminUserIds.map((id) => ({
    type: 'admin_user' as const,
    adminUserId: id,
  }));

  return notifyBulk(db, {
    eventType: 'ticket.reply',
    recipients,
    inApp: {
      title: 'New Ticket',
      body: `${ticket.referenceNumber}: ${ticket.subject} (${priority})`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message: preview,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}

export interface AdminTicketCustomerReplyInput {
  readonly adminUserIds: readonly string[];
  readonly ticket: TicketDescriptor;
  readonly customerLabel: string;
  /** Plain-text excerpt of the customer reply. */
  readonly replyPreview: string;
  /**
   * ID of the customer reply. When present the admin's ticket page
   * scroll-and-highlights this message after navigation.
   */
  readonly messageId?: string;
}

/**
 * Customer replied on a ticket — notify the assigned admin (or fallback
 * to all active admins if unassigned). Caller decides which admin IDs to
 * pass; this helper does not resolve assignment.
 */
export async function notifyAdminTicketCustomerReply(
  db: CrivacyDatabase,
  input: AdminTicketCustomerReplyInput,
): Promise<readonly NotifyResult[]> {
  const { ticket, customerLabel, replyPreview, messageId } = input;

  const recipients: RecipientRef[] = input.adminUserIds.map((id) => ({
    type: 'admin_user' as const,
    adminUserId: id,
  }));

  return notifyBulk(db, {
    eventType: 'ticket.reply',
    recipients,
    inApp: {
      title: 'Customer Replied',
      body: `${ticket.referenceNumber}: new reply from ${customerLabel}.`,
      link: appendMessageDeepLink(`/admin/tickets/${ticket.ticketId}`, messageId),
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message: replyPreview,
          ticketUrl: appendMessageDeepLink(ticket.ticketUrl, messageId),
        }),
    },
  });
}

export interface AdminTicketAssignedInput {
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the admin who performed the assignment. */
  readonly assignedByName: string;
}

/**
 * Ticket assigned (or re-assigned) to an admin — notify the new assignee.
 */
export async function notifyAdminTicketAssigned(
  db: CrivacyDatabase,
  input: AdminTicketAssignedInput,
): Promise<NotifyResult> {
  const { ticket, assignedByName } = input;
  const message = `You have been assigned to ${ticket.referenceNumber}: ${ticket.subject} by ${assignedByName}.`;

  return notify(db, {
    eventType: 'ticket.assigned',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: 'Ticket Assigned to You',
      body: `${ticket.referenceNumber}: ${ticket.subject}`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}

/* ---------- Participant graph notifications ---------- */

export interface AdminParticipantInviteInput {
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the admin who issued the invite. */
  readonly inviterName: string;
  /** Optional inline message the inviter attached. */
  readonly inviteMessage?: string | undefined;
}

/**
 * Same-tier collaborator invite — the recipient must accept or decline.
 * Emits the `ticket.invited` in-app notification and a matching email so
 * the admin can respond from either surface.
 */
export async function notifyAdminParticipantInvited(
  db: CrivacyDatabase,
  input: AdminParticipantInviteInput,
): Promise<NotifyResult> {
  const { ticket, inviterName, inviteMessage } = input;
  const trailer = inviteMessage !== undefined ? `\n\nMessage: ${inviteMessage}` : '';
  const message =
    `${inviterName} invited you to collaborate on ${ticket.referenceNumber}: ${ticket.subject}.` +
    ` Open the ticket to accept or decline.${trailer}`;

  return notify(db, {
    eventType: 'ticket.invited',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: 'Ticket Collaboration Invite',
      body: `${inviterName} invited you to ${ticket.referenceNumber}.`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}

export interface AdminDirectAddedInput {
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the higher-tier admin who added the recipient. */
  readonly addedByName: string;
  /** Optional inline message. */
  readonly addedMessage?: string | undefined;
}

/**
 * Higher-tier direct-add — no accept/decline, the admin is immediately a
 * participant. Delivered via `ticket.added` so recipients can recognise
 * this distinct from a same-tier invite.
 */
export async function notifyAdminDirectAdded(
  db: CrivacyDatabase,
  input: AdminDirectAddedInput,
): Promise<NotifyResult> {
  const { ticket, addedByName, addedMessage } = input;
  const trailer = addedMessage !== undefined ? `\n\nMessage: ${addedMessage}` : '';
  const message =
    `${addedByName} added you to ${ticket.referenceNumber}: ${ticket.subject} as a collaborator.${trailer}`;

  return notify(db, {
    eventType: 'ticket.added',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: 'Added to Ticket',
      body: `${addedByName} added you to ${ticket.referenceNumber}.`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}

export interface AdminInviteRespondedInput {
  /** Original inviter who is being notified of the response. */
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the invited admin who responded. */
  readonly inviteeName: string;
  /** `true` = accepted, `false` = declined. */
  readonly accepted: boolean;
}

/**
 * Inviter feedback — a pending invite was accepted or declined. In-app
 * only (we don't spam email for an internal workflow signal).
 */
export async function notifyAdminInviteResponded(
  db: CrivacyDatabase,
  input: AdminInviteRespondedInput,
): Promise<NotifyResult> {
  const { ticket, inviteeName, accepted } = input;
  const verb = accepted ? 'accepted' : 'declined';

  return notify(db, {
    eventType: 'ticket.invited',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: accepted ? 'Invite Accepted' : 'Invite Declined',
      body: `${inviteeName} ${verb} your invite to ${ticket.referenceNumber}.`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
  });
}

export interface AdminInviteRescindedInput {
  /** The invitee whose pending invite is being cancelled. */
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the admin who rescinded the invite. */
  readonly rescindedByName: string;
  /** Optional free-form reason persisted by the caller. */
  readonly reason?: string | undefined;
}

/**
 * A pending invite was cancelled by the assignee (or superadmin) before
 * the invitee responded. In-app only — the recipient never opted in, so
 * spamming email for a withdrawn ask is worse than a quiet retraction.
 */
export async function notifyAdminInviteRescinded(
  db: CrivacyDatabase,
  input: AdminInviteRescindedInput,
): Promise<NotifyResult> {
  const { ticket, rescindedByName, reason } = input;
  const trailer = reason !== undefined ? ` Reason: ${reason}` : '';

  return notify(db, {
    eventType: 'ticket.invite_rescinded',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: 'Invite Cancelled',
      body: `${rescindedByName} cancelled your invite to ${ticket.referenceNumber}.${trailer}`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
  });
}

export interface AdminParticipantLeftInput {
  readonly adminUserIds: readonly string[];
  readonly ticket: TicketDescriptor;
  /** Display name of the participant who left. */
  readonly leaverName: string;
  /** `true` if the leaver voluntarily left; `false` if they were removed. */
  readonly voluntary: boolean;
}

/**
 * Upper-tier admins are notified when a collaborator leaves (voluntarily
 * or by removal). In-app only — this is workflow signal, not a customer-
 * visible event.
 */
export async function notifyAdminParticipantLeft(
  db: CrivacyDatabase,
  input: AdminParticipantLeftInput,
): Promise<readonly NotifyResult[]> {
  const { ticket, leaverName, voluntary } = input;
  const verb = voluntary ? 'left' : 'was removed from';

  const recipients: RecipientRef[] = input.adminUserIds.map((id) => ({
    type: 'admin_user' as const,
    adminUserId: id,
  }));

  return notifyBulk(db, {
    eventType: 'ticket.participant_left',
    recipients,
    inApp: {
      title: voluntary ? 'Collaborator Left Ticket' : 'Collaborator Removed',
      body: `${leaverName} ${verb} ${ticket.referenceNumber}.`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
  });
}

export interface AdminTicketNeedsPickupInput {
  readonly adminUserIds: readonly string[];
  readonly ticket: TicketDescriptor;
  /** Reason the ticket landed back in the pickup pool. */
  readonly reason: string;
}

/**
 * Broad fan-out when a ticket becomes unassigned (no participants left,
 * pool cleared by superadmin, etc.). In-app only -- this is a backlog
 * grooming signal and emailing every admin for every pool drop would be
 * noisy.
 */
export async function notifyAdminTicketNeedsPickup(
  db: CrivacyDatabase,
  input: AdminTicketNeedsPickupInput,
): Promise<readonly NotifyResult[]> {
  const { ticket, reason } = input;

  const recipients: RecipientRef[] = input.adminUserIds.map((id) => ({
    type: 'admin_user' as const,
    adminUserId: id,
  }));

  return notifyBulk(db, {
    eventType: 'ticket.needs_pickup',
    recipients,
    inApp: {
      title: 'Ticket Needs Pickup',
      body: `${ticket.referenceNumber}: ${ticket.subject} -- ${reason}`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
  });
}

export interface AdminTicketMentionedInput {
  readonly adminUserIds: readonly string[];
  readonly ticket: TicketDescriptor;
  /** Display name of the author who wrote the mentioning message. */
  readonly authorName: string;
  /** Plain-text excerpt of the message (already truncated by the caller). */
  readonly messagePreview: string;
  /** Whether the mention came from an internal (staff-only) note. */
  readonly isInternal: boolean;
  /**
   * ID of the message that contains the mention. When present the
   * recipient's ticket page scroll-and-highlights the exact message
   * they were tagged in, rather than dropping them at the bottom of
   * a long thread.
   */
  readonly messageId?: string;
}

/**
 * `@mention` fan-out. Elevated over a plain `ticket.reply`: every
 * mention always lands in-app and, by default, via email too so a
 * targeted tag is not swallowed by the author's normal reply
 * throttling. Dispatched in bulk; the dispatcher still respects each
 * recipient's preferences and security-event gating.
 */
export async function notifyAdminTicketMentioned(
  db: CrivacyDatabase,
  input: AdminTicketMentionedInput,
): Promise<readonly NotifyResult[]> {
  const { ticket, authorName, messagePreview, isInternal, messageId } = input;
  const kind = isInternal ? 'internal note' : 'message';
  const summary =
    `${authorName} mentioned you in a ${kind} on ${ticket.referenceNumber}: ${ticket.subject}.`;

  const recipients: RecipientRef[] = input.adminUserIds.map((id) => ({
    type: 'admin_user' as const,
    adminUserId: id,
  }));

  return notifyBulk(db, {
    eventType: 'ticket.mentioned',
    recipients,
    inApp: {
      title: 'You Were Mentioned',
      body: `${authorName} mentioned you on ${ticket.referenceNumber}.`,
      link: appendMessageDeepLink(`/admin/tickets/${ticket.ticketId}`, messageId),
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message: `${summary}\n\n${messagePreview}`,
          ticketUrl: appendMessageDeepLink(ticket.ticketUrl, messageId),
        }),
    },
  });
}

export interface AdminTicketTakenOverInput {
  /** The admin who was displaced (previous assignee). */
  readonly adminUserId: string;
  readonly ticket: TicketDescriptor;
  /** Display name of the superadmin who performed the take-over. */
  readonly takenByName: string;
  /** Whether the displaced assignee remains on the ticket as collaborator. */
  readonly stayedAsCollab: boolean;
  /** Optional free-form reason persisted by the caller. */
  readonly reason?: string | undefined;
}

/**
 * Notify the displaced assignee after a superadmin take-over. Emails by
 * default — losing assignee status on someone else's initiative is
 * important enough that the target should hear about it out-of-band.
 */
export async function notifyAdminTicketTakenOver(
  db: CrivacyDatabase,
  input: AdminTicketTakenOverInput,
): Promise<NotifyResult> {
  const { ticket, takenByName, stayedAsCollab, reason } = input;
  const role = stayedAsCollab ? 'a collaborator' : 'removed from the ticket';
  const reasonTrailer = reason !== undefined ? `\n\nReason: ${reason}` : '';
  const message =
    `${takenByName} took over ${ticket.referenceNumber}: ${ticket.subject}.` +
    ` You are now ${role}.${reasonTrailer}`;

  return notify(db, {
    eventType: 'ticket.taken_over',
    recipient: { type: 'admin_user', adminUserId: input.adminUserId },
    inApp: {
      title: 'Ticket Taken Over',
      body: `${takenByName} took over ${ticket.referenceNumber}.`,
      link: `/admin/tickets/${ticket.ticketId}`,
    },
    email: {
      emailType: 'ticket_update',
      build: ({ displayName }) =>
        ticketUpdateEmail({
          displayName,
          ticketRef: ticket.referenceNumber,
          ticketSubject: ticket.subject,
          message,
          ticketUrl: ticket.ticketUrl,
        }),
    },
  });
}
