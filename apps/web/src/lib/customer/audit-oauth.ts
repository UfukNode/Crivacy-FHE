/**
 * Centralized audit emit for the customer-side Google OAuth flow.
 *
 * F-A2-I1-001 (Page 2 closure): six events under the
 * `customer.login.oauth.*` namespace cover the credential-creation
 * forensic trail Cat 38 actor×journey requires for the OAuth
 * journey. Previously the callback wrote four ad-hoc actions
 * (`customer.google_login`, `customer.google_linked`,
 * `customer.google_registered`, `customer.oauth_failed`) and
 * skipped the replay / collision / promotion edges — which left
 * incident response unable to prove (a) whether a stolen state
 * cookie was attempted at scale, (b) whether a sub-collision race
 * landed an attacker's link, or (c) whether a pending-verification
 * customer was silently promoted to active.
 *
 * Action namespace:
 *   * `customer.login.oauth.success`         — login completed (linked-account-exists branch or post-confirm-link).
 *   * `customer.login.oauth.failed`          — any failure during the flow.
 *   * `customer.login.oauth.account_linked`  — `customer_linked_accounts` row written.
 *   * `customer.login.oauth.status_promoted` — `pending_verification → active` flipped after IdP-trust.
 *   * `customer.login.oauth.sub_collision`   — `createLinkedAccount` returned null (race or override attempt).
 *   * `customer.login.oauth.replay_blocked`  — `oauth_state_used` burn collision.
 *
 * Read-time PII redaction is applied by the audit pipeline
 * (`lib/audit/redact.ts`) — meta is stored as-given and redacted
 * per-audience on read. Don't pre-redact here.
 *
 * Brand-new-user registration keeps its existing
 * `customer.google_registered` action (different journey — register
 * vs login), and the unlink path keeps `customer.google_unlinked`
 * (Cat 14 cluster).
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget, uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { AuditAction } from '@/lib/audit/actions';

export type OAuthAuditEventName =
  | 'success'
  | 'failed'
  | 'account_linked'
  | 'status_promoted'
  | 'sub_collision'
  | 'replay_blocked';

export interface OAuthAuditCtx {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly now: Date;
}

export interface OAuthAuditTarget {
  readonly customerId?: string;
}

/**
 * Emit a single `customer.login.oauth.<event>` audit row. The actor
 * is always `system:customer-auth` because OAuth flows are mostly
 * pre-session (no firm/admin/customer actor reliably available on
 * the failed branch). The customer ID, when known, becomes the
 * audit target so the event surfaces under the customer's
 * `/settings/security/audit-log` view.
 */
export async function auditOAuthEvent(
  db: CrivacyDatabase,
  ctx: OAuthAuditCtx,
  event: OAuthAuditEventName,
  meta: Readonly<Record<string, unknown>>,
  target: OAuthAuditTarget = {},
): Promise<void> {
  const auditCtx = buildAuditContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  // The action key is constructed from a closed event union — the
  // cast pins it back to the strong AuditAction union which has the
  // matching six identifiers registered (`lib/audit/actions.ts`).
  const action = `customer.login.oauth.${event}` as AuditAction;
  await writeAudit(db, {
    action,
    actor: systemActor('customer-auth'),
    target:
      target.customerId !== undefined
        ? uuidTarget({ kind: 'customer', id: target.customerId })
        : noTarget(),
    context: auditCtx,
    meta,
    ts: ctx.now,
  });
}
