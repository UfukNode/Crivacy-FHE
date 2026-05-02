/**
 * Shared dispatcher for the "new sign-in from an unrecognised
 * device" alert email.
 *
 * Why this lives as its own module: every audience's login handler
 * (customer / firm / admin) needs the same sequence — probe the
 * sessions table for a prior match, render the
 * `newLoginAlertEmail` template with audience-appropriate copy, and
 * queue the send best-effort. Without the shared dispatcher the
 * logic would copy-paste four times (customer login; firm login;
 * admin step-1 no-TOTP; admin step-2 post-TOTP) and drift within
 * one patch cycle.
 *
 * The dispatcher is **best-effort**: if the DB lookup fails we
 * assume the device is known (fail-closed on the probe, see
 * `isNewDeviceForUser`); if the email enqueue fails we log and
 * move on so a flaky SMTP path cannot block a successful login.
 *
 * @module
 */

import { parseDeviceName } from '@/lib/auth/device-name';
import type { CrivacyDatabase } from '@/lib/db/client';
import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { newLoginAlertEmail } from '@/lib/email/templates';
import { getAppUrl } from '@/lib/env/app-url';
import { getRootLogger } from '@/lib/observability/logger';

import { isNewDeviceForUser, type LoginAudience } from './new-device-detection';

export interface DispatchNewDeviceAlertInput {
  readonly db: CrivacyDatabase;
  readonly audience: LoginAudience;
  readonly userId: string;
  /** Account's email address. When `null` the alert is silently skipped. */
  readonly email: string | null;
  /** Human-readable name shown at the top of the email. */
  readonly displayName: string;
  /** Client IP (already normalised; typically `ctx.ip`). */
  readonly ip: string | null;
  /** Raw `User-Agent` — parsed into a friendly device name inside. */
  readonly userAgent: string | null;
  /** Handler's clock value; reused as the alert's "time" field. */
  readonly now: Date;
  /**
   * Relative path on our origin that opens the "sessions / security"
   * screen for this audience. The dispatcher prepends
   * `NEXT_PUBLIC_APP_URL`. Examples: `/settings/security` for
   * customers, `/dashboard/settings/security` for firm users.
   */
  readonly securityUrlPath: string;
}

/**
 * Probe the audience's session table; when the `(ip, device_name)`
 * pair is unseen inside the lookback window AND an email is on
 * file, enqueue the new-sign-in alert. All failures are swallowed
 * so the caller never has to try/catch.
 */
export async function dispatchNewDeviceAlert(
  input: DispatchNewDeviceAlertInput,
): Promise<void> {
  if (input.email === null || input.email.length === 0) {
    // Wallet-only customers / not-yet-reachable admins: nothing to
    // send. In-app notifications would be the natural follow-up if
    // that surface is added later.
    return;
  }

  const deviceName = parseDeviceName(input.userAgent);
  const isNew = await isNewDeviceForUser({
    db: input.db,
    audience: input.audience,
    userId: input.userId,
    ip: input.ip,
    deviceName,
    now: input.now,
  });
  if (!isNew) return;

  try {
    const appUrl = getAppUrl();
    const emailContent = newLoginAlertEmail({
      displayName: input.displayName,
      deviceName: deviceName ?? 'Unknown device',
      city: 'Unknown',
      ipAddress: input.ip ?? 'Unknown',
      timestamp: input.now.toISOString(),
      securityUrl: `${appUrl}${input.securityUrlPath}`,
    });
    await enqueueEmailFromRoute(input.db, {
      to: input.email,
      content: emailContent,
      emailType: 'login_alert',
      userId: input.userId,
    });
  } catch (err) {
    getRootLogger().warn(
      {
        event: 'new_device_alert_dispatch_failed',
        audience: input.audience,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'new-device alert dispatch failed',
    );
  }
}
