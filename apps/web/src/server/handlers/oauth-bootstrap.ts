/**
 * OAuth consent bootstrap — framework-independent resolver.
 *
 * Collects every piece of state the `/oauth/consent` page needs to
 * render — the authorize request, the client metadata, scope
 * descriptions, cached-consent fast path, KYC gate signals — and
 * returns it as a plain object. Both call sites (the public
 * `/api/v1/oauth/consent/bootstrap` route and the server-component
 * that renders the consent page) go through this function so the
 * logic lives in exactly one place.
 *
 * The server component used to fetch its own API via `fetch` with a
 * synthesised origin (built from the inbound `Host` +
 * `X-Forwarded-Proto` headers). A misconfigured reverse proxy that
 * didn't strip `Host` would let an attacker point the self-fetch at
 * an arbitrary domain — the customer session cookie was forwarded
 * on every call, so the cookie could leak outbound. Calling this
 * resolver directly keeps the whole flow inside the process: no
 * self-fetch, no origin synthesis, no cookie forwarding over the
 * network.
 *
 * Errors flow back through a discriminated-union outcome rather
 * than exceptions so the caller can map each case to its own
 * HTTP status without a try/catch-based dispatch.
 *
 * @module
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { oauthClients } from '@/lib/db/schema';
import {
  OAUTH_SCOPES,
  OauthError,
  canonicaliseScope,
  hashScope,
  maxRequiredLevel,
  parseScope,
  rankKycLevel,
  type OauthScopeId,
  type ScopeRequiredLevel,
} from '@/lib/oauth';
import {
  findActiveConsent,
  findAuthorizationRequest,
} from '@/server/repositories';

import {
  ensureAuthRequestOwnership,
  findActiveCredentialForUser,
} from './oauth-shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OauthConsentBootstrapDeps {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  readonly customer: {
    readonly id: string;
    readonly email: string | null;
    readonly kycLevel: string;
  };
}

/**
 * The JSON shape the consent page expects. This has historically
 * been defined implicitly inside the route handler; lifting it out
 * into a named interface makes it obvious when a refactor accidentally
 * drops or renames a field.
 */
export interface OauthConsentBootstrapSnapshot {
  readonly request: {
    readonly id: string;
    readonly scope: string;
    readonly scopes: ReadonlyArray<{
      readonly id: OauthScopeId;
      readonly description: string;
      readonly requiredLevel: ScopeRequiredLevel;
    }>;
    readonly redirectUri: string;
    readonly expiresAt: string;
    readonly requiredLevel: ScopeRequiredLevel;
  };
  readonly client: {
    readonly name: string;
    readonly description: string | null;
    readonly logoUrl: string | null;
    readonly homepageUrl: string | null;
  };
  readonly user: {
    readonly id: string;
    readonly email: string | null;
    readonly kycLevel: string;
    readonly credentialLevel: ScopeRequiredLevel | null;
  };
  readonly kycGate: {
    readonly needsKyc: boolean;
    readonly needsKycUpgrade: boolean;
    readonly missingScopes: readonly OauthScopeId[];
  };
  readonly cachedConsent: {
    readonly id: string;
    readonly grantedAt: string;
    readonly expiresAt: string;
  } | null;
}

/**
 * Error codes the resolver can report. Each one maps to a specific
 * HTTP status on the route side and to a specific branch on the
 * server-component side (redirect vs error card).
 */
export type OauthConsentBootstrapErrorCode =
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'owner_mismatch'
  | 'validation_failed';

export type OauthConsentBootstrapOutcome =
  | { readonly ok: true; readonly snapshot: OauthConsentBootstrapSnapshot }
  | {
      readonly ok: false;
      readonly code: OauthConsentBootstrapErrorCode;
      readonly message: string;
      readonly status: number;
    };

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export async function resolveOauthConsentBootstrap(
  deps: OauthConsentBootstrapDeps,
  requestId: string,
): Promise<OauthConsentBootstrapOutcome> {
  const authRequest = await findAuthorizationRequest(deps.db, requestId);
  if (authRequest === null) {
    return {
      ok: false,
      code: 'not_found',
      message: 'Authorization request not found.',
      status: 404,
    };
  }
  if (authRequest.completedAt !== null) {
    return {
      ok: false,
      code: 'conflict',
      message: 'This authorization request has already been completed.',
      status: 409,
    };
  }
  if (authRequest.expiresAt.getTime() <= deps.now.getTime()) {
    return {
      ok: false,
      code: 'expired',
      message: 'Authorization request has expired.',
      status: 410,
    };
  }

  // Ownership gate — the authenticated caller must be the customer
  // the authorize request was minted for. TOFU on first sight;
  // later callers with a different session are rejected.
  const ownership = await ensureAuthRequestOwnership(
    deps.db,
    authRequest,
    deps.customer.id,
  );
  if (!ownership.ok) {
    return {
      ok: false,
      code: 'owner_mismatch',
      message: 'This authorization request belongs to a different user.',
      status: 403,
    };
  }

  // Load the client for display data.
  const clientRows = await deps.db
    .select()
    .from(oauthClients)
    .where(
      and(eq(oauthClients.id, authRequest.clientId), isNull(oauthClients.revokedAt)),
    )
    .limit(1);
  const client = clientRows[0];
  if (client === undefined) {
    return {
      ok: false,
      code: 'not_found',
      message: 'OAuth client is no longer active.',
      status: 404,
    };
  }

  let parsedScopes: readonly OauthScopeId[];
  try {
    parsedScopes = parseScope(authRequest.scope);
  } catch (err) {
    if (err instanceof OauthError) {
      return {
        ok: false,
        code: 'validation_failed',
        message: err.message,
        status: 400,
      };
    }
    throw err;
  }

  const canonicalScope = canonicaliseScope(parsedScopes);
  const scopeHashValue = hashScope(parsedScopes);

  // Fast-path: cached consent covers this exact scope set?
  const cachedConsent = await findActiveConsent(
    deps.db,
    deps.customer.id,
    authRequest.clientId,
    scopeHashValue,
    deps.now,
  );

  // KYC gate signals — user's current level versus what the
  // requested scopes demand.
  const credential = await findActiveCredentialForUser(
    deps.db,
    deps.customer.id,
    deps.now,
  );
  const maxLevel = maxRequiredLevel(parsedScopes);
  const currentRank = credential === null ? -1 : rankKycLevel(credential.level);
  const neededRank = rankKycLevel(maxLevel);

  const needsKyc = neededRank >= 0 && credential === null;
  const needsKycUpgrade =
    neededRank >= 0 && credential !== null && currentRank < neededRank;
  const missingScopes: readonly OauthScopeId[] =
    neededRank < 0
      ? []
      : parsedScopes.filter((id) => {
          const req = OAUTH_SCOPES[id].requiredLevel;
          const reqRank = rankKycLevel(req);
          return reqRank > currentRank;
        });

  const requiredLevel: ScopeRequiredLevel = maxLevel;
  const credentialLevel =
    credential === null ? null : (credential.level as ScopeRequiredLevel);

  const scopeDetails = parsedScopes.map((scope) => ({
    id: scope,
    description: OAUTH_SCOPES[scope].description,
    requiredLevel: OAUTH_SCOPES[scope].requiredLevel,
  }));

  const snapshot: OauthConsentBootstrapSnapshot = {
    request: {
      id: authRequest.requestId,
      scope: canonicalScope,
      scopes: scopeDetails,
      redirectUri: authRequest.redirectUri,
      expiresAt: authRequest.expiresAt.toISOString(),
      requiredLevel,
    },
    client: {
      name: client.name,
      description: client.description,
      logoUrl: client.logoUrl,
      homepageUrl: client.homepageUrl,
    },
    user: {
      id: deps.customer.id,
      email: deps.customer.email,
      kycLevel: deps.customer.kycLevel,
      credentialLevel,
    },
    kycGate: {
      needsKyc,
      needsKycUpgrade,
      missingScopes,
    },
    cachedConsent:
      cachedConsent !== null
        ? {
            id: cachedConsent.id,
            grantedAt: cachedConsent.grantedAt.toISOString(),
            expiresAt: cachedConsent.expiresAt.toISOString(),
          }
        : null,
  };

  return { ok: true, snapshot };
}
