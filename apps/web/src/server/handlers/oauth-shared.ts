/**
 * Shared OAuth query helpers used by both the /token and /userinfo
 * handlers. Single source of truth for "fetch the active credential
 * for this customer" so the claims builder input never drifts
 * between the two surfaces.
 *
 * ## Customer ↔ credential linking
 *
 * Crivacy stores every issued credential in `kyc_credentials_meta`
 * keyed by `(firm_id, user_ref)`. B2B firms create rows with their
 * own firm_id and their own `user_ref`; the Crivacy-direct
 * onboarding flow (`app.crivacy.io`) uses a dedicated "self-service"
 * firm row and sets `user_ref = customers.id` so every customer has
 * a stable home row. OAuth clients always resolve claims off this
 * self-service row — they're reading the customer's canonical
 * Crivacy credential, not any firm-issued variant.
 *
 * The self-service firm id comes from `CRIVACY_SELF_SERVICE_FIRM_ID`
 * (same env the credential-pipeline worker reads when it stores the
 * row). If the env is missing we treat it as "no credential
 * available" and log — the OAuth flow still succeeds, the firm just
 * sees an id_token with only `sub` (no KYC claims), and their own
 * downstream policy decides whether to accept. That's strictly
 * safer than throwing 500 on every /oauth/token call during a
 * transient env-config drift.
 *
 * @module
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { kycCredentialsMeta } from '@/lib/db/schema';
import type { OauthAuthorizationRequest } from '@/lib/db/schema';
import {
  fromKycCredentialMetaRow,
  type CredentialView,
} from '@/lib/credentials/view';
import { getRootLogger } from '@/lib/observability/logger';
import {
  attachUserToAuthorizationRequest,
  findAuthorizationRequest,
} from '@/server/repositories';

let cachedSelfServiceFirmId: string | null | undefined;
let configWarningEmitted = false;

function getSelfServiceFirmId(): string | null {
  if (cachedSelfServiceFirmId !== undefined) return cachedSelfServiceFirmId;
  const raw = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];
  if (raw === undefined || raw.trim().length === 0) {
    if (!configWarningEmitted) {
      // One-shot console warning — we can't pull the pino logger here
      getRootLogger().warn(
        { event: 'oauth_self_service_firm_id_missing' },
        'CRIVACY_SELF_SERVICE_FIRM_ID env missing — OAuth id_token/userinfo will omit KYC claims',
      );
      configWarningEmitted = true;
    }
    cachedSelfServiceFirmId = null;
    return null;
  }
  cachedSelfServiceFirmId = raw.trim();
  return cachedSelfServiceFirmId;
}

/**
 * Test-only hook. Flushes the memoised env read so suites that
 * mutate `process.env.CRIVACY_SELF_SERVICE_FIRM_ID` between cases
 * see each fresh value.
 */
export function resetSelfServiceFirmCacheForTests(): void {
  cachedSelfServiceFirmId = undefined;
  configWarningEmitted = false;
}

/**
 * Load the most-recent active Crivacy-direct credential for a user.
 * Returns `null` when:
 *
 *   - the self-service firm id env is missing (soft-fail, logged)
 *   - the user has never completed KYC via `app.crivacy.io`
 *   - every prior credential is revoked / expired / superseded
 *
 * The caller (token + userinfo handlers) emits the id_token with
 * just `sub` when `null` comes back, so firms that don't need KYC
 * still get a functional OIDC login and firms that DO need KYC see
 * a token with no KYC claims and apply their own "please finish
 * verification" policy.
 */
export async function findActiveCredentialForUser(
  db: CrivacyDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<CredentialView | null> {
  const selfServiceFirmId = getSelfServiceFirmId();
  if (selfServiceFirmId === null) return null;

  // Pull the full row and project through the canonical view —
  // saves the field-by-field transcription this function used to
  // do, and guarantees every consumer of the OAuth + REST + webhook
  // surfaces sees the same shape (`lib/credentials/view.ts` is the
  // single source of truth).
  const rows = await db
    .select()
    .from(kycCredentialsMeta)
    .where(
      and(
        eq(kycCredentialsMeta.firmId, selfServiceFirmId),
        eq(kycCredentialsMeta.userRef, userId),
        eq(kycCredentialsMeta.status, 'active'),
        isNull(kycCredentialsMeta.revokedAt),
        gt(kycCredentialsMeta.validUntil, now),
      ),
    )
    .orderBy(desc(kycCredentialsMeta.confirmedAt), desc(kycCredentialsMeta.createdAt))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return fromKycCredentialMetaRow(row);
}

// ---------------------------------------------------------------------------
// Authorize-request ↔ customer ownership gate
// ---------------------------------------------------------------------------

/**
 * Outcome of `ensureAuthRequestOwnership`. The `ok: true` case reports
 * whether we had to claim the row — useful for audit annotations but
 * functionally irrelevant to the caller's control flow.
 */
export type AuthRequestOwnershipResult =
  | { readonly ok: true; readonly attached: boolean }
  | { readonly ok: false; readonly reason: 'owner_mismatch' };

/**
 * Verify that the current authenticated customer is the rightful
 * owner of this authorize request. Handles three cases:
 *
 *   1. `authRequest.user_id === customerId` — already bound to us,
 *      nothing to do.
 *   2. `authRequest.user_id === null` — TOFU attach: atomically
 *      claim ownership. If the claim UPDATE touches zero rows we
 *      lost the race to a concurrent writer, so we re-read and
 *      verify the row now belongs to us before allowing the caller
 *      to continue.
 *   3. `authRequest.user_id !== customerId` — another customer
 *      already owns this row. Refuse.
 *
 * Before this gate, a request minted by customer A could be driven
 * to completion by customer B if B logged into the same browser and
 * opened the consent URL — the handler trusted the session alone
 * and never compared it against the request's bound owner. Every
 * consent / kyc-start entry point runs through here so that code
 * and tokens can only be minted for the customer who actually owns
 * the authorize request.
 */
export async function ensureAuthRequestOwnership(
  db: CrivacyDatabase,
  authRequest: OauthAuthorizationRequest,
  customerId: string,
): Promise<AuthRequestOwnershipResult> {
  if (authRequest.userId === customerId) {
    return { ok: true, attached: false };
  }
  if (authRequest.userId !== null) {
    return { ok: false, reason: 'owner_mismatch' };
  }

  const claimed = await attachUserToAuthorizationRequest(
    db,
    authRequest.requestId,
    customerId,
  );
  if (claimed) {
    return { ok: true, attached: true };
  }

  // Someone else won the attach race. Pull the row again and only
  // allow the caller through when the row turns out to belong to
  // them anyway (e.g. a duplicate bootstrap call from the same
  // session). Otherwise surface the mismatch.
  const fresh = await findAuthorizationRequest(db, authRequest.requestId);
  if (fresh === null || fresh.userId !== customerId) {
    return { ok: false, reason: 'owner_mismatch' };
  }
  return { ok: true, attached: false };
}
