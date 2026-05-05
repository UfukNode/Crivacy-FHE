import type { CrivacyDatabase } from '@/lib/db/client';
import { accountStatusChangeEmail } from '@/lib/email/templates';
import type { AccountStatusAction } from '@/lib/email/templates';
/**
 * Centralized customer status change notification.
 *
 * Thin wrapper over the central {@link notify} dispatcher that encodes the
 * per-action in-app content and email template for account status changes
 * (ban, suspend, lock, unban, unlock, activate, reset_kyc).
 *
 * What stays the same after the dispatcher refactor:
 *   - Single call site per status change
 *   - Null email guard for wallet-only customers (handled by dispatcher)
 *   - Security event bypass: `account.status_changed` is in
 *     {@link SECURITY_EVENT_TYPES} so channel preferences are ignored —
 *     critical account actions are always delivered
 *   - Non-throwing — a notification failure never blocks the admin action
 *   - Rate limiting via `enqueueEmailFromRoute`
 *
 * @module
 */
import { notify } from './dispatcher';

/* ---------- Types ---------- */

export type { AccountStatusAction } from '@/lib/email/templates';

export interface StatusChangeInput {
  readonly customerId: string;
  readonly action: AccountStatusAction;
  /** Optional reason surfaced in the email body (not shown in-app). */
  readonly reason?: string | undefined;
}

export interface StatusChangeResult {
  readonly notificationCreated: boolean;
  readonly emailEnqueued: boolean;
}

/* ---------- In-app notification content per action ---------- */

interface NotificationContent {
  readonly title: string;
  readonly body: string;
  readonly link?: string;
}

const NOTIFICATION_MAP: Readonly<Record<AccountStatusAction, NotificationContent>> = {
  banned: {
    title: 'Account Banned',
    body: 'Your account has been permanently banned due to a policy violation. Contact support if you believe this is an error.',
  },
  suspended: {
    title: 'Account Suspended',
    body: 'Your account has been suspended. Contact support for more information.',
  },
  locked: {
    title: 'Account Locked',
    body: 'Your account has been locked. Contact support for more information.',
  },
  unbanned: {
    title: 'Account Reinstated',
    body: 'Your account ban has been lifted. You can now log in.',
  },
  unbanned_review: {
    title: 'Account Ban Lifted',
    body: 'Your account ban has been lifted. Your account is now under review.',
  },
  unlocked: {
    title: 'Account Unlocked',
    body: 'Your account has been unlocked. You can now log in.',
  },
  activated: {
    title: 'Account Activated',
    body: 'Your account has been activated. You can now log in.',
  },
  kyc_reset: {
    title: 'KYC Verification Reset',
    body: 'Your identity verification has been reset. Please complete verification again.',
    link: '/kyc',
  },
};

/* ---------- Public API ---------- */

/**
 * Send both an in-app notification and a status-change email to a customer.
 *
 * Delegates all recipient resolution, preference gating, rate limiting, and
 * error containment to {@link notify}. Wallet-only customers (email = null)
 * receive the in-app notification only; the email channel is skipped
 * gracefully by the dispatcher.
 */
export async function notifyCustomerStatusChange(
  db: CrivacyDatabase,
  input: StatusChangeInput,
): Promise<StatusChangeResult> {
  const content = NOTIFICATION_MAP[input.action];
  const eventType = input.action === 'kyc_reset'
    ? 'kyc.status_changed' as const
    : 'account.status_changed' as const;

  const result = await notify(db, {
    eventType,
    recipient: { type: 'customer', customerId: input.customerId },
    inApp: {
      title: content.title,
      body: content.body,
      ...(content.link !== undefined && { link: content.link }),
    },
    email: {
      emailType: 'account_status',
      build: ({ displayName }) =>
        accountStatusChangeEmail({
          displayName,
          action: input.action,
          reason: input.reason,
        }),
    },
  });

  return {
    notificationCreated: result.notificationCreated,
    emailEnqueued: result.emailEnqueued,
  };
}
