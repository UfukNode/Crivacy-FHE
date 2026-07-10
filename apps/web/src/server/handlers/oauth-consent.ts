/**
 * OAuth consent decision handler.
 *
 * Called from the consent form POST once the user picks Approve or
 * Reject. On Approve:
 *   - Persist a consent row (or upsert an already-revoked one).
 *   - Mint an authorization code tied to the authorize-request state.
 *   - Mark the authorize request completed so duplicate submits are
 *     idempotent.
 *   - Return a redirect URL pointing back at the firm's
 *     `redirect_uri` with `?code=…&state=…`.
 *
 * On Reject:
 *   - Mark the authorize request completed with reject flag.
 *   - Return a redirect URL with `?error=access_denied&state=…`.
 *
 * The handler never redirects the browser itself; it returns a JSON
 * body with the URL so the consent client can navigate. Same pattern
 * the customer-profile flows use so error-mapper integration stays
 * trivial.
 *
 * @module
 */

import { and, eq, isNull } from 'drizzle-orm';

import { customerActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { CrivacyDatabase } from '@/lib/db/client';
import { firms, oauthClients } from '@/lib/db/schema';
import { getCustomerWalletAddress } from '@/lib/fhe/customer-address';
import { upsertPendingGrant } from '@/server/repositories/firm-grants';
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_SCOPES,
  OauthError,
  assertConsentCovers,
  canonicaliseScope,
  dispatchOauthConsentEvent,
  generateAuthorizationCode,
  hashAuthorizationCode,
  hashScope,
  maxRequiredLevel,
  parseScope,
  rankKycLevel,
} from '@/lib/oauth';
import {
  ensureAuthRequestOwnership,
  findActiveCredentialForUser,
} from './oauth-shared';
import {
  findActiveConsent,
  findAuthorizationRequest,
  insertAuthorizationCode,
  insertConsent,
  markAuthorizationRequestCompleted,
} from '@/server/repositories';

export interface OauthConsentDeps {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  readonly ip: string | null;
  /**
   * Human-readable label for the customer who made the decision.
   * Typically `customer.email ?? customer.id`; passed through so the
   * handler can stamp an audit row without the actor shape leaking
   * back into the route.
   */
  readonly customerLabel: string;
  readonly userAgent: string | null;
  readonly requestAuditId: string | null;
}

export interface OauthConsentInput {
  readonly requestId: string;
  /** Authenticated customer id — caller supplies from session. */
  readonly userId: string;
  readonly decision: 'approve' | 'reject';
}

export interface OauthConsentResult {
  /** URL the consent page should navigate to after processing. */
  readonly redirectUrl: string;
}

export async function handleOauthConsentDecision(
  deps: OauthConsentDeps,
  input: OauthConsentInput,
): Promise<OauthConsentResult> {
  // --- 1. Load the in-flight authorize request --------------------------
  const authRequest = await findAuthorizationRequest(deps.db, input.requestId);
  if (authRequest === null) {
    throw new OauthError('request_not_found', 'Authorization request not found.');
  }
  if (authRequest.completedAt !== null) {
    throw new OauthError(
      'invalid_request',
      'This authorization request has already been completed.',
    );
  }
  if (authRequest.expiresAt.getTime() <= deps.now.getTime()) {
    throw new OauthError('request_expired', 'Authorization request has expired.');
  }

  // --- 1a. Ownership gate ----------------------------------------------
  //
  // Refuse to proceed when the session on this call isn't the
  // customer the authorize request was bound to. The bootstrap
  // endpoint already runs this same gate, but consent POST is the
  // mutation boundary — an attacker could skip the bootstrap step
  // entirely by scripting the POST directly, so the check has to
  // live here too. First-seen attach still happens so a request
  // minted anonymously (cookie-less authorize) becomes bound to
  // this customer before the code is issued.
  const ownership = await ensureAuthRequestOwnership(
    deps.db,
    authRequest,
    input.userId,
  );
  if (!ownership.ok) {
    throw new OauthError(
      'access_denied',
      'This authorization request belongs to a different user.',
    );
  }

  // --- 1b. Load client + defence-in-depth redirect_uri re-check ---------
  //
  // /authorize already validates `redirect_uri` against the client's
  // whitelist, so `authRequest.redirectUri` should always be in
  // `clientRow.redirectUris` by construction. We re-verify here
  // anyway: the consent handler is the last gate before we assemble
  // a URL and hand it to the user's browser, and an invariant
  // violation (DB tamper, migration bug, future weakening of the
  // authorize-time validator) would otherwise become an open
  // redirect. Cheap check, catastrophic blast-radius if skipped.
  const clientRow = await findClientByUuid(deps.db, authRequest.clientId);
  if (clientRow === null) {
    throw new OauthError('invalid_client', 'Client not found or revoked.');
  }
  if (!clientRow.redirectUris.includes(authRequest.redirectUri)) {
    throw new OauthError(
      'redirect_uri_mismatch',
      'Authorization request redirect_uri is no longer registered for this client.',
    );
  }

  // --- 2. Reject path ---------------------------------------------------
  //
  // Claim the authorize request before building the redirect URL. The
  // claim is atomic: exactly one concurrent caller flips `completed_at`
  // from NULL and wins; a second reject (or a racing approve on the
  // same `request_id`) loses the claim and gets `invalid_request`. No
  // duplicate redirects, no silent duplicate mutations.
  if (input.decision === 'reject') {
    const claimed = await markAuthorizationRequestCompleted(
      deps.db,
      input.requestId,
      deps.now,
    );
    if (!claimed) {
      throw new OauthError(
        'invalid_request',
        'This authorization request has already been completed.',
      );
    }
    const url = new URL(authRequest.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User rejected the consent request.');
    if (authRequest.state !== null) {
      url.searchParams.set('state', authRequest.state);
    }
    return { redirectUrl: url.toString() };
  }

  // --- 3. Approve path: persist consent then mint code ------------------
  const parsedScopes = parseScope(authRequest.scope);
  const canonicalScope = canonicaliseScope(parsedScopes);
  const scopeHashValue = hashScope(parsedScopes);

  // --- 3a. Server-side KYC gate (defence-in-depth) ----------------------
  //
  // The consent page refuses to render the approve button when the
  // user's credential level is below the requested scopes' demand,
  // but the POST endpoint must re-assert the rule: a buggy or
  // adversarial client could bypass the UI entirely. Failing here
  // means the user gets an explicit `kyc_required` error instead of
  // silently receiving a token with zero KYC claims.
  //
  // Pre-TX on purpose: a failing gate throws before we touch any
  // mutation path, so the authorize request stays unclaimed and the
  // user can retry after completing KYC.
  const requiredLevel = maxRequiredLevel(parsedScopes);
  if (requiredLevel !== null) {
    const credential = await findActiveCredentialForUser(deps.db, input.userId, deps.now);
    const currentRank = credential === null ? -1 : rankKycLevel(credential.level);
    if (currentRank < rankKycLevel(requiredLevel)) {
      const missingScopes = parsedScopes.filter((id) => {
        const req = OAUTH_SCOPES[id].requiredLevel;
        return rankKycLevel(req) > currentRank;
      });
      throw new OauthError(
        'access_denied',
        `Your current verification level does not cover the requested scopes (need ${requiredLevel}).`,
        {
          detail: JSON.stringify({
            requiredLevel,
            currentLevel: credential?.level ?? null,
            missingScopes,
          }),
        },
      );
    }
  }

  // Mint the code + persist the consent/audit inside a single TX.
  //
  // Ordering matters: the TX begins by CLAIMING the authorize
  // request (atomic `UPDATE … WHERE completed_at IS NULL RETURNING`).
  // The claim returns `true` only for the unique writer that flips
  // the flag; a concurrent consent submit on the same `request_id`
  // loses the claim, and throwing inside the callback rolls back the
  // whole transaction — no orphan consent row, no orphan code.
  //
  // Audit write shares the TX so a failing audit also rolls back the
  // claim (keeps the invariant "every consent grant has an audit row
  // in committed state"). Webhook fan-out runs AFTER commit because a
  // firm endpoint failure must never undo a user's consent.
  const rawCode = generateAuthorizationCode();
  const codeHashValue = hashAuthorizationCode(rawCode);
  const codeExpiresAt = new Date(deps.now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000);

  const txResult = await deps.db.transaction(async (tx) => {
    const claimed = await markAuthorizationRequestCompleted(tx, input.requestId, deps.now);
    if (!claimed) {
      throw new OauthError(
        'invalid_request',
        'This authorization request has already been completed.',
      );
    }

    // Look up any still-valid cached consent so we don't create a
    // duplicate row when the user is re-approving a scope they
    // already consented to within the TTL window.
    const existingConsent = await findActiveConsent(
      tx,
      input.userId,
      authRequest.clientId,
      scopeHashValue,
      deps.now,
    );
    let newlyCreatedConsent: { id: string; grantedAt: Date; expiresAt: Date } | null = null;
    if (existingConsent !== null) {
      // Defence-in-depth — the authorize step already verified this,
      // but consent is a mutation boundary. If somehow the row has
      // drifted to a narrower scope, bail instead of quietly issuing
      // a code with unapproved claims.
      assertConsentCovers(parsedScopes, parseScope(existingConsent.scope));
    } else {
      const expiresAt = new Date(
        deps.now.getTime() + clientRow.consentTtlDays * 24 * 60 * 60 * 1000,
      );
      const inserted = await insertConsent(tx, {
        userId: input.userId,
        clientId: authRequest.clientId,
        scope: canonicalScope,
        scopeHash: scopeHashValue,
        grantedAt: deps.now,
        expiresAt,
      });
      newlyCreatedConsent = {
        id: inserted.id,
        grantedAt: inserted.grantedAt,
        expiresAt: inserted.expiresAt,
      };
    }

    await insertAuthorizationCode(tx, {
      codeHash: codeHashValue,
      clientId: authRequest.clientId,
      userId: input.userId,
      scope: canonicalScope,
      redirectUri: authRequest.redirectUri,
      nonce: authRequest.nonce,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      ipBoundTo: deps.ip,
      expiresAt: codeExpiresAt,
    });

    if (newlyCreatedConsent !== null) {
      await writeAudit(tx, {
        action: 'oauth_consent.granted',
        actor: customerActor({ id: input.userId, label: deps.customerLabel }),
        target: uuidTarget({ kind: 'oauth_consent', id: newlyCreatedConsent.id }),
        context: buildAuditRequestContext({
          ip: deps.ip,
          userAgent: deps.userAgent,
          requestId: deps.requestAuditId,
        }),
        meta: {
          clientId: clientRow.clientId,
          clientUuid: clientRow.id,
          scope: canonicalScope,
          expiresAt: newlyCreatedConsent.expiresAt.toISOString(),
        },
        ts: deps.now,
      });
    }

    return { newlyCreatedConsent };
  });

  // Fire the consent-granted webhook only on a *new* grant. A
  // re-authorization against a still-valid cached consent is
  // invisible to the firm (it was notified when the row was first
  // created) and re-firing would spam their webhook.
  //
  // Runs AFTER the TX commits so a webhook fan-out error cannot roll
  // back the consent mutation the user has already approved.
  if (txResult.newlyCreatedConsent !== null) {
    await dispatchOauthConsentEvent(deps.db, 'oauth.consent.granted', {
      firmId: clientRow.firmId,
      clientId: clientRow.clientId,
      clientUuid: clientRow.id,
      userId: input.userId,
      consentId: txResult.newlyCreatedConsent.id,
      scope: canonicalScope,
      grantedAt: txResult.newlyCreatedConsent.grantedAt,
      expiresAt: txResult.newlyCreatedConsent.expiresAt,
    });
  }

  // --- 4. FHE per-user access grant (gatekeeper handoff) ----------------
  //
  // Only on a NEW consent grant (a re-authorization against a still-valid
  // cached consent already granted on chain; a level upgrade produces a new
  // scope hash → new consent row → re-grants at the higher minLevel).
  //
  // We DON'T call the chain here — the ~15s grantAccess tx must never block
  // the consent redirect. Instead we durably record the intent in
  // `firm_credential_grants (status='pending')`; the grant worker drains it
  // and calls `grantAccess(userAddress, firmAddress, minLevel)`.
  //
  // Fully best-effort and post-commit: the user's consent is already
  // committed, so a bookkeeping failure here must never deny it. It also
  // no-ops cleanly when the firm hasn't connected a wallet (no on-chain
  // address) or the user has no wallet address — the plaintext-lifecycle
  // verify path still works; only the encrypted-verdict decrypt waits.
  if (txResult.newlyCreatedConsent !== null) {
    try {
      const firmAddress = await findFirmOnchainAddress(deps.db, clientRow.firmId);
      if (firmAddress !== null) {
        const userAddress = await getCustomerWalletAddress(deps.db, input.userId);
        if (userAddress !== null) {
          await upsertPendingGrant(deps.db, {
            firmId: clientRow.firmId,
            customerId: input.userId,
            userAddress,
            firmAddress,
            // `requiredLevel` is the max KYC level the consented scopes demand
            // (null when no KYC scope is requested — grant eligibility at the
            // baseline `basic` so the firm can still read an active verdict).
            minLevel: requiredLevel ?? 'basic',
            now: deps.now,
          });
        }
      }
    } catch {
      // Swallow — consent is committed; the grant is a downstream side
      // effect. An operator sweep / next consent re-enqueues.
    }
  }

  const url = new URL(authRequest.redirectUri);
  url.searchParams.set('code', rawCode);
  if (authRequest.state !== null) {
    url.searchParams.set('state', authRequest.state);
  }
  return { redirectUrl: url.toString() };
}

/**
 * Read a firm's registered on-chain (EVM) address, or null when the firm
 * has not connected a wallet. The gatekeeper `grantAccess` targets this
 * address; without it there is nothing to grant to.
 */
async function findFirmOnchainAddress(
  db: CrivacyDatabase,
  firmId: string,
): Promise<string | null> {
  const rows = await db
    .select({ onchainAddress: firms.onchainAddress })
    .from(firms)
    .where(and(eq(firms.id, firmId), isNull(firms.deletedAt)))
    .limit(1);
  return rows[0]?.onchainAddress ?? null;
}

/**
 * Load an OAuth client by its internal uuid without the firm scope
 * check — consent resolution only knows the uuid from the
 * authorize-request FK and the row ownership was verified during
 * authorize.
 */
async function findClientByUuid(db: CrivacyDatabase, clientUuid: string) {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, clientUuid), isNull(oauthClients.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}
