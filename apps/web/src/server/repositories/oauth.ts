/**
 * OAuth / OIDC data access.
 *
 * Every OAuth handler reads and writes through this module. Keeping
 * queries centralised means the security-critical invariants (code
 * single-use, consent revoke cascade, authorization-request expiry)
 * live in one place and can be reasoned about without hunting
 * through handler code.
 *
 * @module
 */

import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthConsents,
} from '@/lib/db/schema';
import type {
  OauthAccessToken,
  OauthAuthorizationCode,
  OauthAuthorizationRequest,
  OauthClient,
  OauthConsent,
} from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Count every OAuth client owned by the firm, including revoked
 * rows. Revoked clients stay in the table for audit continuity, so
 * the tier cap intentionally counts them — a firm that repeatedly
 * revoked and recreated would otherwise bypass the ceiling.
 */
export async function countOauthClientsByFirm(
  db: CrivacyDatabase,
  firmId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(oauthClients)
    .where(eq(oauthClients.firmId, firmId));
  return rows[0]?.count ?? 0;
}

export async function findOauthClientByClientId(
  db: CrivacyDatabase,
  clientId: string,
): Promise<OauthClient | null> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findOauthClientById(
  db: CrivacyDatabase,
  id: string,
  firmId: string,
): Promise<OauthClient | null> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.id, id), eq(oauthClients.firmId, firmId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listOauthClientsForFirm(
  db: CrivacyDatabase,
  firmId: string,
): Promise<readonly OauthClient[]> {
  return db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.firmId, firmId))
    .orderBy(desc(oauthClients.createdAt));
}

export async function insertOauthClient(
  db: CrivacyDatabase,
  input: {
    readonly firmId: string;
    readonly clientId: string;
    readonly clientSecretHash: string | null;
    readonly name: string;
    readonly description: string | null;
    readonly logoUrl: string | null;
    readonly homepageUrl: string | null;
    readonly redirectUris: readonly string[];
    readonly allowedScopes: readonly string[];
    readonly isPublicClient: boolean;
    readonly consentTtlDays: number;
    readonly createdByFirmUserId: string | null;
  },
): Promise<OauthClient> {
  const rows = await db
    .insert(oauthClients)
    .values({
      firmId: input.firmId,
      clientId: input.clientId,
      clientSecretHash: input.clientSecretHash,
      name: input.name,
      description: input.description,
      logoUrl: input.logoUrl,
      homepageUrl: input.homepageUrl,
      redirectUris: [...input.redirectUris],
      allowedScopes: [...input.allowedScopes],
      isPublicClient: input.isPublicClient,
      consentTtlDays: input.consentTtlDays,
      createdByFirmUserId: input.createdByFirmUserId,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('oauth_clients insert returned no rows');
  }
  return row;
}

// ---------------------------------------------------------------------------
// Authorization requests
// ---------------------------------------------------------------------------

export async function insertAuthorizationRequest(
  db: CrivacyDatabase,
  input: {
    readonly requestId: string;
    readonly clientId: string;
    /**
     * Customer id to bind this request to. Populated at authorize
     * time when the caller already holds a valid customer session
     * cookie. Null when the user reaches /authorize anonymously and
     * logs in (or signs up) later; the consent bootstrap then
     * attaches the user id via `attachUserToAuthorizationRequest`.
     * Every downstream handler cross-checks this value against the
     * authenticated caller so a request created for user A can never
     * mint a code for user B.
     */
    readonly userId: string | null;
    readonly redirectUri: string;
    readonly scope: string;
    readonly state: string | null;
    readonly codeChallenge: string | null;
    readonly codeChallengeMethod: string | null;
    readonly uiLocales: string | null;
    readonly nonce: string | null;
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.insert(oauthAuthorizationRequests).values({
    requestId: input.requestId,
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    uiLocales: input.uiLocales,
    nonce: input.nonce,
    ip: input.ip,
    userAgent: input.userAgent,
    expiresAt: input.expiresAt,
  });
}

export async function findAuthorizationRequest(
  db: CrivacyDatabase,
  requestId: string,
): Promise<OauthAuthorizationRequest | null> {
  const rows = await db
    .select()
    .from(oauthAuthorizationRequests)
    .where(eq(oauthAuthorizationRequests.requestId, requestId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically attach a customer id to an authorize request that was
 * created anonymously. Succeeds only when `user_id` is still NULL —
 * a second writer (an attacker racing the legitimate user through
 * the consent bootstrap) returns `false` and the caller must re-read
 * the row to decide whether the owner is still themselves.
 *
 * The `WHERE user_id IS NULL` guard is the lock; without it a later
 * call could silently overwrite an owner and steer the request to a
 * different customer.
 */
export async function attachUserToAuthorizationRequest(
  db: CrivacyDatabase,
  requestId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(oauthAuthorizationRequests)
    .set({ userId })
    .where(
      and(
        eq(oauthAuthorizationRequests.requestId, requestId),
        isNull(oauthAuthorizationRequests.userId),
      ),
    )
    .returning({ requestId: oauthAuthorizationRequests.requestId });
  return rows.length > 0;
}

/**
 * Atomically claim an authorization request as completed.
 *
 * Returns `true` when this call flipped `completed_at` from NULL to
 * `now`; `false` when a concurrent caller already claimed the row.
 * Callers MUST gate all subsequent mutations (code mint, consent
 * insert) on the claim so a single `request_id` can never mint two
 * codes. Two parallel consent submits otherwise both observed
 * `completed_at === null`, both inserted codes, and both marked the
 * request completed — the second half of the race was the silent
 * duplicate-mint.
 */
export async function markAuthorizationRequestCompleted(
  db: CrivacyDatabase,
  requestId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(oauthAuthorizationRequests)
    .set({ completedAt: now })
    .where(
      and(
        eq(oauthAuthorizationRequests.requestId, requestId),
        isNull(oauthAuthorizationRequests.completedAt),
      ),
    )
    .returning({ requestId: oauthAuthorizationRequests.requestId });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function insertAuthorizationCode(
  db: CrivacyDatabase,
  input: {
    readonly codeHash: string;
    readonly clientId: string;
    readonly userId: string;
    readonly scope: string;
    readonly redirectUri: string;
    readonly nonce: string | null;
    readonly codeChallenge: string | null;
    readonly codeChallengeMethod: string | null;
    readonly ipBoundTo: string | null;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: input.codeHash,
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    redirectUri: input.redirectUri,
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    ipBoundTo: input.ipBoundTo,
    expiresAt: input.expiresAt,
  });
}

export async function findAuthorizationCode(
  db: CrivacyDatabase,
  codeHash: string,
): Promise<OauthAuthorizationCode | null> {
  const rows = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically burn a code. Uses `updated rows` as the burn signal so
 * two concurrent exchanges both see "success" locally but only one
 * flips `used_at` — the loser hits 0 rows and the caller returns
 * `used_code`.
 */
export async function burnAuthorizationCode(
  db: CrivacyDatabase,
  codeHash: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        isNull(oauthAuthorizationCodes.usedAt),
      ),
    )
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  return rows.length > 0;
}

/**
 * Revoke every access token tied to a specific authorization code.
 * Triggered by the code-reuse detector — if a code is presented
 * twice, RFC 9700 §2.1.1 requires invalidating anything it ever
 * minted (the honest client lost the race; the attacker got the
 * tokens).
 */
export async function revokeTokensMintedFromCode(
  db: CrivacyDatabase,
  codeHash: string,
  now: Date,
  reason: string,
): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(
        eq(oauthAccessTokens.authorizationCodeHash, codeHash),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------

export async function findActiveConsent(
  db: CrivacyDatabase,
  userId: string,
  clientId: string,
  scopeHash: string,
  now: Date,
): Promise<OauthConsent | null> {
  const rows = await db
    .select()
    .from(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId),
        eq(oauthConsents.scopeHash, scopeHash),
        isNull(oauthConsents.revokedAt),
        gt(oauthConsents.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listConsentsForUser(
  db: CrivacyDatabase,
  userId: string,
): Promise<readonly OauthConsent[]> {
  return db
    .select()
    .from(oauthConsents)
    .where(eq(oauthConsents.userId, userId))
    .orderBy(desc(oauthConsents.grantedAt));
}

export async function insertConsent(
  db: CrivacyDatabase,
  input: {
    readonly userId: string;
    readonly clientId: string;
    readonly scope: string;
    readonly scopeHash: string;
    readonly grantedAt: Date;
    readonly expiresAt: Date;
  },
): Promise<OauthConsent> {
  const rows = await db
    .insert(oauthConsents)
    .values({
      userId: input.userId,
      clientId: input.clientId,
      scope: input.scope,
      scopeHash: input.scopeHash,
      grantedAt: input.grantedAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('oauth_consents insert returned no rows');
  }
  return row;
}

export async function touchConsent(
  db: CrivacyDatabase,
  consentId: string,
  now: Date,
): Promise<void> {
  await db
    .update(oauthConsents)
    .set({ lastUsedAt: now })
    .where(eq(oauthConsents.id, consentId));
}

export async function revokeConsent(
  db: CrivacyDatabase,
  consentId: string,
  now: Date,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(oauthConsents)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(oauthConsents.id, consentId), isNull(oauthConsents.revokedAt)));
    // Cascade: kill every access token issued against this consent.
    await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: now, revokedReason: `consent_revoked:${reason}` })
      .where(
        and(
          eq(oauthAccessTokens.consentId, consentId),
          isNull(oauthAccessTokens.revokedAt),
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export async function insertAccessToken(
  db: CrivacyDatabase,
  input: {
    readonly tokenHash: string;
    readonly clientId: string;
    readonly userId: string;
    readonly consentId: string;
    readonly authorizationCodeHash: string | null;
    readonly scope: string;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.insert(oauthAccessTokens).values({
    tokenHash: input.tokenHash,
    clientId: input.clientId,
    userId: input.userId,
    consentId: input.consentId,
    authorizationCodeHash: input.authorizationCodeHash,
    scope: input.scope,
    expiresAt: input.expiresAt,
  });
}

export async function findAccessToken(
  db: CrivacyDatabase,
  tokenHash: string,
): Promise<OauthAccessToken | null> {
  // Inner-join on `oauth_clients` so tokens whose minting client has
  // been revoked are invisible to `/userinfo` immediately — even
  // before the dashboard-revoke cascade has finished stamping
  // `revoked_at` on the token rows themselves. Without this join,
  // a leaked token kept answering for its full 60-minute TTL after
  // the firm admin had already killed the client. The cascade
  // (`handleDashboardRevokeOauthClient`) still runs so the kill is
  // visible in audit logs and in the dashboard's active-token
  // counter; the join is belt-and-suspenders that closes the gap
  // between "client revoked" and "every minted token stamped".
  const rows = await db
    .select({
      tokenHash: oauthAccessTokens.tokenHash,
      clientId: oauthAccessTokens.clientId,
      userId: oauthAccessTokens.userId,
      consentId: oauthAccessTokens.consentId,
      authorizationCodeHash: oauthAccessTokens.authorizationCodeHash,
      scope: oauthAccessTokens.scope,
      expiresAt: oauthAccessTokens.expiresAt,
      revokedAt: oauthAccessTokens.revokedAt,
      revokedReason: oauthAccessTokens.revokedReason,
      lastUsedAt: oauthAccessTokens.lastUsedAt,
      createdAt: oauthAccessTokens.createdAt,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthAccessTokens.clientId, oauthClients.id))
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthClients.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function touchAccessToken(
  db: CrivacyDatabase,
  tokenHash: string,
  now: Date,
): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ lastUsedAt: now })
    .where(eq(oauthAccessTokens.tokenHash, tokenHash));
}

export async function revokeAccessToken(
  db: CrivacyDatabase,
  tokenHash: string,
  now: Date,
  reason: string,
): Promise<boolean> {
  const rows = await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(eq(oauthAccessTokens.tokenHash, tokenHash), isNull(oauthAccessTokens.revokedAt)),
    )
    .returning({ tokenHash: oauthAccessTokens.tokenHash });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Cleanup (can be called by a cron or cleanup worker)
// ---------------------------------------------------------------------------

export async function deleteExpiredAuthorizationRequests(
  db: CrivacyDatabase,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(oauthAuthorizationRequests)
    .where(lt(oauthAuthorizationRequests.expiresAt, now))
    .returning({ requestId: oauthAuthorizationRequests.requestId });
  return rows.length;
}

export async function deleteExpiredAuthorizationCodes(
  db: CrivacyDatabase,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(oauthAuthorizationCodes)
    .where(lt(oauthAuthorizationCodes.expiresAt, now))
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  return rows.length;
}
