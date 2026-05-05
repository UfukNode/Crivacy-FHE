/**
 * `@/lib/notification` barrel — public API for the notification subsystem.
 *
 * @module
 */

export { createNotification } from './create';
export type { CreateNotificationInput } from './create';

export { notify, notifyBulk } from './dispatcher';
export type {
  NotifyInput,
  NotifyBulkInput,
  NotifyResult,
  RecipientRef,
  InAppContent,
  EmailChannel,
  ResolvedContact,
} from './dispatcher';

export { notifyCustomerStatusChange } from './status-change';
export type { StatusChangeInput, StatusChangeResult, AccountStatusAction } from './status-change';

export {
  notifyCustomerTicketReply,
  notifyCustomerTicketStatusChange,
  notifyAdminNewTicket,
  notifyAdminTicketCustomerReply,
  notifyAdminTicketAssigned,
  notifyAdminParticipantInvited,
  notifyAdminDirectAdded,
  notifyAdminInviteResponded,
  notifyAdminInviteRescinded,
  notifyAdminParticipantLeft,
  notifyAdminTicketNeedsPickup,
  notifyAdminTicketMentioned,
  notifyAdminTicketTakenOver,
} from './ticket';
export type {
  TicketDescriptor,
  CustomerTicketReplyInput,
  CustomerTicketStatusChangeInput,
  AdminNewTicketInput,
  AdminTicketCustomerReplyInput,
  AdminTicketAssignedInput,
  AdminParticipantInviteInput,
  AdminDirectAddedInput,
  AdminInviteRespondedInput,
  AdminInviteRescindedInput,
  AdminParticipantLeftInput,
  AdminTicketNeedsPickupInput,
  AdminTicketMentionedInput,
  AdminTicketTakenOverInput,
} from './ticket';

export {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from './query';
export type { ListNotificationsOptions, ListNotificationsResult } from './query';

export {
  NOTIFICATION_TYPES,
  SECURITY_EVENT_TYPES,
  isSecurityEvent,
} from './types';
export type {
  NotificationType,
  NotificationItem,
  NotificationPreferenceItem,
} from './types';
