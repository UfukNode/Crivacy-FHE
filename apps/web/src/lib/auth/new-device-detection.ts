/**
 * New-device detection for login-alert emails.
 *
 * When a customer / firm user / admin signs in from an IP + device
 * pair the system has never seen for that account, we fire the
 * `newLoginAlertEmail` template so the user has a chance to notice
 * an account compromise before the attacker does damage. This is the
 * same pattern Gmail, GitHub, and AWS use — the single-most-
 * noticeable anti-account-takeover signal from the user's side.
 *
 * The check is approximate by design:
 *
 *   * Matching is `(ip, device_name)` — a returning user on the
 *     same browser from the same network does NOT get an alert.
 *   * Switching networks (WiFi → 4G) or upgrading the browser
 *     *does* count as a new device. False positives here are cheap
 *     ("new sign-in from your phone") and infinitely preferable to
 *     false negatives on a real takeover.
 *   * The lookback window is 90 days — longer windows grow the
 *     session table scan linearly without adding much signal, since
 *     a dormant device re-appearing after three months is itself a
 *     reasonable thing to surface.
 *
 * The helper returns a plain boolean. Callers decide what to do with
 * it (typically: enqueue a login-alert email). DB errors fail
 * **closed** — on failure we treat the device as *known* so we do
 * not spam users on a transient DB blip.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';

/**
 * Login audience enumeration — the three distinct subject tables
 * whose sessions we query for prior-device signals. `customer` hits
 * `customer_sessions`; `firm` and `admin` share the `sessions` table
 * with a `user_kind` discriminator.
 */
export type LoginAudience = 'customer' | 'firm' | 'admin';

const DEFAULT_LOOKBACK_DAYS = 90;

export interface IsNewDeviceForUserInput {
  readonly db: CrivacyDatabase;
  readonly audience: LoginAudience;
  readonly userId: string;
  readonly ip: string | null;
  readonly deviceName: string | null;
  readonly now?: Date;
  readonly lookbackDays?: number;
}

/**
 * Generic new-device probe. Returns `true` when the
 * `(userId, ip, device_name)` triple has no session row in the
 * audience-specific table within the lookback window.
 *
 * All three audiences share this entry point so the login-alert
 * dispatcher stays agnostic and the SQL for the customer vs
 * firm/admin tables lives in one place.
 */
export async function isNewDeviceForUser(
  input: IsNewDeviceForUserInput,
): Promise<boolean> {
  const { db, audience, userId, ip, deviceName } = input;
  const now = input.now ?? new Date();
  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  if (ip === null) return false;
  const cutoff = new Date(now.getTime() - lookbackDays * 86400 * 1000);

  try {
    const result =
      audience === 'customer'
        ? await db.execute<{ count: string }>(
            deviceName === null
              ? sql`SELECT COUNT(*)::text AS count
                      FROM customer_sessions
                     WHERE customer_id = ${userId}
                       AND ip = ${ip}
                       AND device_name IS NULL
                       AND issued_at > ${cutoff.toISOString()}`
              : sql`SELECT COUNT(*)::text AS count
                      FROM customer_sessions
                     WHERE customer_id = ${userId}
                       AND ip = ${ip}
                       AND device_name = ${deviceName}
                       AND issued_at > ${cutoff.toISOString()}`,
          )
        : await db.execute<{ count: string }>(
            deviceName === null
              ? sql`SELECT COUNT(*)::text AS count
                      FROM sessions
                     WHERE user_id = ${userId}
                       AND user_kind = ${audience}
                       AND ip = ${ip}
                       AND device_name IS NULL
                       AND issued_at > ${cutoff.toISOString()}`
              : sql`SELECT COUNT(*)::text AS count
                      FROM sessions
                     WHERE user_id = ${userId}
                       AND user_kind = ${audience}
                       AND ip = ${ip}
                       AND device_name = ${deviceName}
                       AND issued_at > ${cutoff.toISOString()}`,
          );
    const row = result.rows[0] as { count: string } | undefined;
    const count = Number.parseInt(row?.count ?? '0', 10);
    return count === 0;
  } catch (err) {
    getRootLogger().warn(
      {
        event: 'new_device_detection_lookup_failed',
        audience,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'new-device-detection lookup failed',
    );
    return false;
  }
}
