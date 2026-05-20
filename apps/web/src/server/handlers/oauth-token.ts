/**
 * OAuth /token handler — exchange an authorization code for an
 * access token (and optional id_token).
 *
 * This is server-to-server. The firm POSTs
 * `application/x-www-form-urlencoded` with
 * `grant_type=authorization_code`, its `client_id` + `client_secret`
 * (or PKCE verifier for public clients), the `code`, and the same
 * `redirect_uri` it used on /authorize.
 *
 * On success we return the RFC 6749 §5.1 token-response body plus
 * an OIDC id_token when `openid` was in scope. All errors map to
 * RFC 6749 §5.2 error responses.
 *
 * Critical invariants (RFC 9700 §2.1.1):
 *   - Code is single-use. Re-presentation revokes all tokens it
 *     minted AND fails the current exchange.
 *   - PKCE verifier matches the stored challenge.
 *   - `redirect_uri` matches the one recorded at authorize time.
 *   - IP that exchanges must match the IP that received /authorize
 *     (relaxed for public clients to permit mobile → desktop flows).
 *
 * @module
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { eq } from 'drizzle-orm';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getRootLogger } from '@/lib/observability/logger';
import { getAuthConfig } from '@/lib/auth/config';
import type { CrivacyDatabase } from '@/lib/db/client';
import { runOrCatchUnique } from '@/lib/db/unique-violation';
import { oauthClients } from '@/lib/db/schema';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  OauthError,
  assertValidCodeVerifier,
  canonicaliseScope,
  generateAccessToken,
  hashAccessToken,
  hashAuthorizationCode,
  hashScope,
  parseScope,
  signIdToken,
  toOauthClaims,
  verifyClientSecret,
  verifyCodeChallenge,
} from '@/lib/oauth';
import {
  burnAuthorizationCode,
  findActiveConsent,
  findAuthorizationCode,
  findOauthClientByClientId,
  insertAccessToken,
  insertConsent,
  revokeTokensMintedFromCode,
} from '@/server/repositories';

import { findActiveCredentialForUser } from './oauth-shared';

export interface OauthTokenDeps {
  readonly db: CrivacyDatabase;
  readonly now: Date;
  readonly ip: string | null;
  readonly issuerUrl: string;
}

/**
 * Standard RFC 6749 §5.1 token response body. We include OIDC
 * `id_token` whenever the scope contained `openid`.
 */
interface TokenResponseBody {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  id_token?: string;
}

function tokenError(
  error: string,
  description: string,
  status: number = 400,
): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}

export async function handleOauthToken(
  deps: OauthTokenDeps,
  request: NextRequest,
): Promise<NextResponse> {
  // --- 1. Parse form body ------------------------------------------------
  let form: URLSearchParams;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return tokenError(
        'invalid_request',
        'Content-Type must be application/x-www-form-urlencoded.',
      );
    }
    const text = await request.text();
    form = new URLSearchParams(text);
  } catch {
    return tokenError('invalid_request', 'Failed to parse request body.');
  }

  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code') {
    return tokenError(
      'unsupported_grant_type',
      `Only grant_type=authorization_code is supported (got ${String(grantType)}).`,
    );
  }

  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const clientId = form.get('client_id');
  const clientSecret = form.get('client_secret');
  const codeVerifier = form.get('code_verifier');

  if (code === null || redirectUri === null || clientId === null) {
    return tokenError(
      'invalid_request',
      'code, redirect_uri, and client_id are all required.',
    );
  }

  // --- 1b. PKCE verifier shape gate (constant-time timing) --------------
  //
  // If a verifier is supplied we validate its RFC 7636 shape (43-128
  // chars, `[A-Z a-z 0-9 \- . _ ~]` only) BEFORE any DB work. Doing
  // the regex up here keeps malformed inputs from flowing through
  // client lookup, code lookup, and the eventual cryptographic
  // compare — those later paths have different latency profiles
  // that a remote attacker could otherwise use as a timing oracle
  // to enumerate valid authorization codes. The regex is O(1) so
  // this gate is effectively free and stays constant-time regardless
  // of whether the attacker's code guess happens to exist.
  //
  // A missing verifier is still acceptable here (a confidential
  // client without PKCE won't send one); we fall through to the
  // later `codeRow.codeChallenge !== null` branch that enforces the
  // per-code requirement. This gate only rejects `code_verifier`
  // values that cannot possibly match any stored challenge.
  if (codeVerifier !== null) {
    try {
      assertValidCodeVerifier(codeVerifier);
    } catch (err) {
      if (err instanceof OauthError) {
        return tokenError('invalid_request', err.message);
      }
      throw err;
    }
  }

  // --- 2a. Per-client rate limit ----------------------------------------
  //
  // Keyed on the `client_id` string rather than source IP: a firm's
  // backend typically shares a small IP pool across thousands of
  // users, so per-IP caps would either strangle legitimate traffic
  // or be set so high that they fail the threat model. Per-client
  // lets each firm get its own bucket.
  const rateLimited = await maybeRateLimitResponse(
    deps.db,
    'oauth_token',
    clientId,
    deps.now,
  );
  if (rateLimited) return rateLimited;

  // --- 2b. Client lookup ------------------------------------------------
  const client = await findOauthClientByClientId(deps.db, clientId);
  if (client === null) {
    return tokenError('invalid_client', 'Unknown client_id.', 401);
  }
  if (client.revokedAt !== null) {
    return tokenError('invalid_client', 'Client has been revoked.', 401);
  }

  // --- 2c. Temporary lockout from repeated wrong-secret attempts --------
  //
  // Separate from `revoked_at`: self-healing 15-minute window that
  // trips at the 5th miss. Applies only to confidential clients (public
  // clients have no secret to brute-force).
  if (
    !client.isPublicClient &&
    client.secretLockedUntil !== null &&
    client.secretLockedUntil.getTime() > deps.now.getTime()
  ) {
    const retryAfterSeconds = Math.ceil(
      (client.secretLockedUntil.getTime() - deps.now.getTime()) / 1000,
    );
    return new NextResponse(
      JSON.stringify({
        error: {
          code: 'invalid_client',
          error_description: `Client is locked after repeated wrong-secret attempts. Retry in ${retryAfterSeconds} seconds.`,
        },
      }),
      {
        status: 423,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          'Retry-After': String(retryAfterSeconds),
        },
      },
    );
  }

  // --- 2d. Confidential client secret verification ----------------------
  //
  // Public clients authenticate with PKCE alone (RFC 9700 §2.1.1);
  // confidential clients MUST present a matching argon2id-verified
  // secret. Wrong secrets increment the counter; the 5th miss trips
  // the lockout above AND stamps an audit alarm.
  if (!client.isPublicClient) {
    if (clientSecret === null) {
      return tokenError('invalid_client', 'client_secret is required.', 401);
    }
    if (client.clientSecretHash === null) {
      return tokenError('invalid_client', 'Client has no secret configured.', 401);
    }
    const secretOk = await verifyClientSecret(clientSecret, client.clientSecretHash);
    if (!secretOk) {
      const SECRET_LOCKOUT_THRESHOLD = 5;
      const SECRET_LOCKOUT_MINUTES = 15;
      const newCount = (client.failedSecretAttempts ?? 0) + 1;
      if (newCount >= SECRET_LOCKOUT_THRESHOLD) {
        const lockedUntil = new Date(
          deps.now.getTime() + SECRET_LOCKOUT_MINUTES * 60 * 1000,
        );
        await deps.db
          .update(oauthClients)
          .set({ failedSecretAttempts: newCount, secretLockedUntil: lockedUntil })
          .where(eq(oauthClients.id, client.id));
        // Audit the lockout for SOC triage, but don't let an audit
        // failure turn into a 500 for the caller — the lock itself
        // has already been written, which is the security-critical
        // state. Losing an audit row is a monitoring gap, not an
        // auth bypass.
        try {
          await writeAudit(deps.db, {
            action: 'oauth.client_secret_locked',
            actor: systemActor('oauth-token'),
            target: uuidTarget({ kind: 'oauth_client', id: client.id }),
            context: buildAuditRequestContext({
              ip: deps.ip,
              userAgent: null,
              requestId: null,
            }),
            meta: {
              clientId: client.clientId,
              firmId: client.firmId,
              attempts: newCount,
              lockedUntil: lockedUntil.toISOString(),
              lockoutMinutes: SECRET_LOCKOUT_MINUTES,
            },
            ts: deps.now,
          });
        } catch (err) {
          getRootLogger().error(
            {
              event: 'oauth_token_audit_write_failed',
              phase: 'client_secret_locked',
              err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
            },
            'oauth-token audit write failed for client_secret_locked',
          );
        }
        const retryAfterSeconds = SECRET_LOCKOUT_MINUTES * 60;
        return new NextResponse(
          JSON.stringify({
            error: {
              code: 'invalid_client',
              error_description: `Too many wrong secrets. Client locked for ${SECRET_LOCKOUT_MINUTES} minutes.`,
            },
          }),
          {
            status: 423,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              Pragma: 'no-cache',
              'Retry-After': String(retryAfterSeconds),
            },
          },
        );
      }
      await deps.db
        .update(oauthClients)
        .set({ failedSecretAttempts: newCount })
        .where(eq(oauthClients.id, client.id));
      return tokenError('invalid_client', 'client_secret does not match.', 401);
    }

    // Correct secret — clear any residual counter / stale lock that
    // may linger from prior misses. Single UPDATE keeps the happy
    // path one round-trip.
    if (
      (client.failedSecretAttempts ?? 0) > 0 ||
      client.secretLockedUntil !== null
    ) {
      await deps.db
        .update(oauthClients)
        .set({ failedSecretAttempts: 0, secretLockedUntil: null })
        .where(eq(oauthClients.id, client.id));
    }
  }

  // --- 3. Code lookup + pre-burn validation ------------------------------
  const codeHash = hashAuthorizationCode(code);
  const codeRow = await findAuthorizationCode(deps.db, codeHash);
  if (codeRow === null) {
    return tokenError('invalid_grant', 'Authorization code is unknown.');
  }
  if (codeRow.clientId !== client.id) {
    return tokenError('invalid_grant', 'Authorization code was issued to a different client.');
  }
  if (codeRow.redirectUri !== redirectUri) {
    return tokenError(
      'invalid_grant',
      'redirect_uri does not match the value used at /authorize.',
    );
  }
  if (codeRow.expiresAt.getTime() <= deps.now.getTime()) {
    return tokenError('invalid_grant', 'Authorization code has expired.');
  }
  if (codeRow.usedAt !== null) {
    // RFC 9700 §2.1.1 code-reuse defence: detach every token that
    // was ever issued from this code, then error. This branch is an
    // automatic tripped security alarm — stamp an audit row so
    // operators can triage it in the SOC dashboard.
    await revokeTokensMintedFromCode(deps.db, codeHash, deps.now, 'code_reuse_detected');
    await writeAudit(deps.db, {
      action: 'oauth.code_reuse_detected',
      actor: systemActor('oauth-token'),
      target: uuidTarget({ kind: 'oauth_client', id: codeRow.clientId }),
      context: buildAuditRequestContext({
        ip: deps.ip,
        userAgent: null,
        requestId: null,
      }),
      meta: {
        codeHash,
        userId: codeRow.userId,
        firstUsedAt: codeRow.usedAt.toISOString(),
        ipBoundTo: codeRow.ipBoundTo,
        ipPresented: deps.ip,
      },
      ts: deps.now,
    });
    return tokenError(
      'invalid_grant',
      'Authorization code has already been used. All tokens issued from it have been revoked.',
    );
  }

  // --- 4. PKCE verification (pre-burn, pure compute) ---------------------
  //
  // Ordering matters: PKCE + IP validation were previously run
  // AFTER `burnAuthorizationCode`. Any failure on those paths —
  // wrong verifier, IP mismatch, pathological crypto input —
  // would leave the code stamped with `used_at` but no access
  // token issued. A legitimate client retrying with the corrected
  // verifier would then hit the reuse branch above and trip the
  // `oauth.code_reuse_detected` alarm, even though there was no
  // real reuse. Moving the checks to run before burn fixes the
  // false-positive alarm and keeps the burn atomic with the
  // token mint itself (the next TX block below).
  if (codeRow.codeChallenge !== null) {
    if (codeVerifier === null) {
      return tokenError('invalid_request', 'code_verifier is required for this code.');
    }
    try {
      verifyCodeChallenge(
        codeRow.codeChallenge,
        codeRow.codeChallengeMethod ?? 'S256',
        codeVerifier,
      );
    } catch (err) {
      if (err instanceof OauthError) {
        return tokenError('invalid_grant', err.message);
      }
      throw err;
    }
  } else if (client.isPublicClient) {
    // Public clients must have set a challenge at /authorize. A code
    // row with no challenge for a public client means the authorize
    // guard was bypassed — fail closed.
    return tokenError('invalid_grant', 'Public clients must use PKCE.');
  }

  // --- 5. IP binding (confidential clients only) -------------------------
  if (!client.isPublicClient && codeRow.ipBoundTo !== null && deps.ip !== null) {
    if (codeRow.ipBoundTo !== deps.ip) {
      return tokenError(
        'invalid_grant',
        'Token exchange must originate from the same IP that received /authorize.',
      );
    }
  }

  // --- 6. Mint access token atomically with the burn ---------------------
  //
  // burn + (optional) consent insert + access-token insert run
  // inside a single transaction. If `insertAccessToken` fails
  // anywhere downstream (DB constraint, connection drop, etc.),
  // the transaction rolls the burn back so the caller can safely
  // retry the same code — no false `code_reuse_detected` alarm on
  // the second try. Lost-race detection (parallel burn) still
  // fires as its own error inside the TX.
  const parsedScopes = parseScope(codeRow.scope);
  const canonicalScope = canonicaliseScope(parsedScopes);
  const scopeHashValue = hashScope(parsedScopes);
  const rawAccessToken = generateAccessToken();
  const tokenHashValue = hashAccessToken(rawAccessToken);
  const accessExpiresAt = new Date(deps.now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);

  const mintOutcome = await deps.db.transaction(async (tx) => {
    const burned = await burnAuthorizationCode(tx, codeHash, deps.now);
    if (!burned) {
      return { status: 'lost_race' } as const;
    }

    let consent = await findActiveConsent(
      tx,
      codeRow.userId,
      client.id,
      scopeHashValue,
      deps.now,
    );
    if (consent === null) {
      // User consented but cache was absent (first-time consent
      // flow). Stamp a new consent row now so revoke has a row to
      // flip and subsequent authorize calls hit the fast path.
      //
      // AUD-INT-AUTHZ-RACE-002 fix: wrap the INSERT in
      // `runOrCatchUnique` against the `oauth_consents_active_idx`
      // partial unique. A second parallel token-exchange for the
      // same (user, client, scope_hash) — the rare but possible
      // first-consent-with-retry case — would otherwise hit 23505
      // mid-TX and surface as a ham 500 instead of the expected
      // success. On race-loss we re-read the row the winning TX
      // stamped and continue.
      const expiresAt = new Date(
        deps.now.getTime() + client.consentTtlDays * 24 * 60 * 60 * 1000,
      );
      const consentInsert = await runOrCatchUnique(
        () =>
          insertConsent(tx, {
            userId: codeRow.userId,
            clientId: client.id,
            scope: canonicalScope,
            scopeHash: scopeHashValue,
            grantedAt: deps.now,
            expiresAt,
          }),
        ['oauth_consents_active_idx'],
      );
      if (consentInsert.status === 'ok') {
        consent = consentInsert.value;
      } else {
        const winner = await findActiveConsent(
          tx,
          codeRow.userId,
          client.id,
          scopeHashValue,
          deps.now,
        );
        if (winner === null) {
          // Should not happen: unique violation without a winning
          // row means the race-winner rolled back after we caught.
          // Treat as transient — fall back to a clean token error
          // rather than crash the TX.
          throw new OauthError('server_error', 'Concurrent consent insert vanished.');
        }
        consent = winner;
      }
    }

    await insertAccessToken(tx, {
      tokenHash: tokenHashValue,
      clientId: client.id,
      userId: codeRow.userId,
      consentId: consent.id,
      authorizationCodeHash: codeHash,
      scope: canonicalScope,
      expiresAt: accessExpiresAt,
    });

    return { status: 'minted', consent } as const;
  });

  if (mintOutcome.status === 'lost_race') {
    return tokenError('invalid_grant', 'Authorization code is no longer valid.');
  }

  const body: TokenResponseBody = {
    access_token: rawAccessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: canonicalScope,
  };

  // OIDC — only emit id_token when the user asked for `openid`. We
  // sign with the client's secret (OIDC `client_secret_jwt` family,
  // HS256) so the firm can verify offline with material it already
  // has. Public clients skip id_token signing because HS256 needs a
  // shared secret.
  if (parsedScopes.includes('openid') && !client.isPublicClient && clientSecret !== null) {
    const view = await findActiveCredentialForUser(deps.db, codeRow.userId);
    const claims = toOauthClaims({
      userId: codeRow.userId,
      view,
      scopes: parsedScopes,
    });
    const signed = await signIdToken(
      {
        userId: codeRow.userId,
        clientId: client.clientId,
        nonce: codeRow.nonce,
        claims,
        issuer: deps.issuerUrl,
        secret: clientSecret,
        ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      },
      deps.now,
    );
    body.id_token = signed.token;
  }

  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

// Referenced by token + userinfo handlers to load the credential the
// claims builder needs. Lives in a shared module so both consumers
// see the same shape and the query is defined once.
export { findActiveCredentialForUser } from './oauth-shared';

// Make `getAuthConfig` stay imported for future use (issuer URL
// resolution, JWT secret fallback). Routes compute the issuer via
// `getAuthConfig().jwtIssuer` and pass it in as `deps.issuerUrl`.
void getAuthConfig;
