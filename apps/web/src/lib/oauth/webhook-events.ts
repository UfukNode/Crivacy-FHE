/**
 * OAuth consent-lifecycle webhook emission.
 *
 * Consent events are firm-scoped: a grant / revoke event only
 * means something to the OAuth client it was raised against, not
 * to every other firm the user has a separate relationship with.
 * So both paths use {@link emitFirmEvent} instead of the user-scoped
 * helper used by `credential.*` / `kyc.session.*`.
 *
 * Payload shape mirrors the `credential.*` events: a flat JSON
 * object with the identifiers + timestamps a firm needs to
 * reconcile its local cache. The user is identified by the `userId`
 * (Crivacy customer uuid, same `sub` claim the firm already has in
 * their id_token) so there is no cross-firm leakage.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';
import { emitFirmEvent } from '@/lib/webhook';

export type OauthConsentEventType =
  | 'oauth.consent.granted'
  | 'oauth.consent.revoked';

export interface OauthConsentEventInput {
  readonly firmId: string;
  readonly clientId: string;
  readonly clientUuid: string;
  readonly userId: string;
  readonly consentId: string;
  readonly scope: string;
  readonly grantedAt?: Date;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly reason?: string;
}

/**
 * Writes the `webhook_events` row + one `webhook_deliveries` per
 * matching endpoint via `emitFirmEvent`. Swallows delivery errors
 * — the caller's consent mutation has already committed and a
 * failed webhook must not surface as a 500 to the user.
 *
 * Idempotency key is `{type}:{consentId}:{grantedAt|revokedAt}` so
 * replays against the same consent-state transition collapse to a
 * single delivery.
 */
export async function dispatchOauthConsentEvent(
  db: CrivacyDatabase,
  type: OauthConsentEventType,
  input: OauthConsentEventInput,
): Promise<void> {
  const timestampKey =
    type === 'oauth.consent.granted'
      ? (input.grantedAt ?? new Date()).toISOString()
      : (input.revokedAt ?? new Date()).toISOString();

  try {
    await emitFirmEvent(db, {
      firmId: input.firmId,
      type,
      payload: {
        consentId: input.consentId,
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        grantedAt: input.grantedAt?.toISOString(),
        expiresAt: input.expiresAt?.toISOString(),
        revokedAt: input.revokedAt?.toISOString(),
        reason: input.reason,
      },
      idempotencyKey: `${type}:${input.consentId}:${timestampKey}`,
      now: new Date(),
    });
  } catch (err) {
    // Webhook dispatch failure is non-critical — the underlying
    // consent mutation already committed. Log and continue so the
    // user-facing response stays successful.
    getRootLogger().error(
      {
        event: 'oauth_webhook_dispatch_failed',
        type,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'oauth-webhook dispatch failed',
    );
  }
}
