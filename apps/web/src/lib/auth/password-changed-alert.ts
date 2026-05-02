/**
 * Shared dispatcher for the "your password was changed" notification.
 *
 * Mirror of {@link `./new-device-alert.ts`} — customer and firm
 * password-rotation paths (change-password, set-password, reset-
 * password, firm reset) all need the same "notify the account
 * holder in their inbox" side-effect. Centralising the template
 * render + email enqueue keeps the copy, the timestamp format, and
 * the audience-to-security-URL mapping in one place so drift cannot
 * develop across call-sites.
 *
 * Best-effort: an SMTP or queue failure is logged and the caller
 * proceeds. We never block a password write on a notification
 * dispatch — the write is the security-critical step.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { passwordChangedEmail } from '@/lib/email/templates';
import { getAppUrl } from '@/lib/env/app-url';
import { getRootLogger } from '@/lib/observability/logger';

/**
 * Audiences that currently have a self-service password-rotation
 * path. Admin was originally excluded because admin passwords were
 * provisioned by platform operators, but Phase 4 adds a self-service
 * admin password-change flow so `admin` joins the audience union —
 * same alert copy + rate-limit behaviour as the firm branch.
 */
export type PasswordChangedAudience = 'customer' | 'firm' | 'admin';

export interface DispatchPasswordChangedAlertInput {
  readonly db: CrivacyDatabase;
  readonly audience: PasswordChangedAudience;
  readonly userId: string;
  /** Account's email address. When `null`/empty the alert is silently skipped. */
  readonly email: string | null;
  /** Human-readable name shown at the top of the email. */
  readonly displayName: string;
  /** Client IP (already normalised; typically `ctx.ip`). */
  readonly ip: string | null;
  /** Handler's clock value; reused as the alert's "time" field. */
  readonly now: Date;
  /**
   * Relative path on our origin that opens the audience-appropriate
   * security settings screen. The dispatcher prepends
   * `NEXT_PUBLIC_APP_URL`.
   */
  readonly securityUrlPath: string;
  /**
   * What kind of rotation triggered the notification — drives the
   * email subject and body copy.
   *
   *   * `changed` — authenticated user rotated their password via
   *     the "Change password" flow
   *   * `set` — wallet-only customer added a password for the first
   *     time
   *   * `reset` — forgot-password flow completed successfully
   */
  readonly reason: 'changed' | 'set' | 'reset';
}

/**
 * Render and enqueue the password-changed notification. Silently
 * no-ops when no email is on file (wallet-only customer without a
 * linked email) or when the underlying dispatch fails.
 */
export async function dispatchPasswordChangedAlert(
  input: DispatchPasswordChangedAlertInput,
): Promise<void> {
  if (input.email === null || input.email.length === 0) {
    return;
  }
  try {
    const appUrl = getAppUrl();
    const emailContent = passwordChangedEmail({
      displayName: input.displayName,
      timestamp: input.now.toISOString(),
      ipAddress: input.ip ?? 'Unknown',
      securityUrl: `${appUrl}${input.securityUrlPath}`,
      reason: input.reason,
    });
    await enqueueEmailFromRoute(input.db, {
      to: input.email,
      content: emailContent,
      // `notification` falls into the per-user hourly cap in
      // `lib/email/rate-limit.ts`, matching other security-posture
      // alerts. Password rotations are infrequent enough that the
      // hourly cap never fires under normal use.
      emailType: 'notification',
      userId: input.userId,
    });
  } catch (err) {
    getRootLogger().warn(
      {
        event: 'password_changed_alert_dispatch_failed',
        audience: input.audience,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'password change-notification dispatch failed',
    );
  }
}
