/**
 * GET /api/customer/auth/google/callback
 *
 * Google OAuth callback. Supports two modes:
 *
 * ## Login mode (default):
 * A) Linked account exists → login → set cookies → redirect to /
 * B) Customer exists with same email → auto-link → login → redirect to /
 * C) No account → create customer directly → login → redirect to /
 *
 * ## Link mode (mode=link in state JWT):
 * Requires active customer session. Links Google account to the logged-in customer.
 * → redirect to /settings/security?google=linked
 *
 * On error → redirect to /login?error=oauth_failed (login mode)
 *          → redirect to /settings/security?error=... (link mode)
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';

import { enforceAuthRateLimit } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import type { AuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getAppUrl } from '@/lib/env/app-url';
import { getRootLogger } from '@/lib/observability/logger';
import { signAccessToken, generateRefreshToken } from '@/lib/auth/jwt';
import { emitSecurityEvent } from '@/lib/security-events';
import { buildRequestContext } from '@/server/context';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import type { CustomerAuthConfig } from '@/lib/customer/config';
import {
  verifyOAuthState,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  signConfirmLinkToken,
} from '@/lib/customer/google-oauth';
import {
  findLinkedAccount,
  findCustomerByEmail,
  createLinkedAccount,
} from '@/lib/customer/linked-accounts';
import { assertCustomerActive } from '@/lib/customer/status-check';
import { CustomerError, isCustomerError } from '@/lib/customer/errors';
import { claimOAuthStateJti } from '@/lib/customer/oauth-state-burn';
import { auditOAuthEvent } from '@/lib/customer/audit-oauth';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { parseDeviceName } from '@/lib/auth/device-name';

import {
  OAUTH_NONCE_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_ACCESS_COOKIE,
} from '@/lib/auth/cookie-names';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { welcomeEmail } from '@/lib/email/templates';

const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);
  const authConfig = getAuthConfig();
  const customerConfig = getCustomerAuthConfig();
  const isProduction = process.env.NODE_ENV === 'production';
  const origin = request.nextUrl.origin;
  const auditCtx = buildAuditContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });

  try {
    // --- 0. Per-IP rate limit (F-A2-001). Callback is a navigation-
    //        level GET, so a 429 JSON would render as raw text in the
    //        browser; redirect to the login page with `oauth_failed`
    //        instead. The state JWT + nonce cookie pair is the
    //        primary anti-replay defence; this cap is defence-in-depth
    //        against a stolen state being walked through harvested
    //        codes at scale.
    const rlDecision = await enforceAuthRateLimit(
      db,
      'customer_oauth_callback',
      ctx.ip,
      ctx.now,
    );
    if (!rlDecision.allowed) {
      return redirectToLogin(origin, 'oauth_failed');
    }

    // --- 1. Extract query params ---
    const { searchParams } = request.nextUrl;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Google returned an error (e.g. user cancelled consent)
    if (error) {
      await auditOAuthEvent(db, ctx, 'failed', {
        provider: 'google',
        reason: 'idp_error',
        error,
      });
      // Try to determine mode from state to redirect appropriately
      if (state) {
        try {
          const parsed = await verifyOAuthState(state, authConfig.jwtSecret);
          if (parsed.mode === 'link') {
            return redirectToSettings(origin, 'google_link_failed');
          }
        } catch { /* state invalid, fall through to login redirect */ }
      }
      return redirectToLogin(origin, 'oauth_failed');
    }

    if (!code || !state) {
      return redirectToLogin(origin, 'oauth_failed');
    }

    // --- 2. Verify state (CSRF) ---
    const storedNonce = request.cookies.get(OAUTH_NONCE_COOKIE)?.value;
    if (!storedNonce) {
      return redirectToLogin(origin, 'oauth_failed');
    }

    let stateResult: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      stateResult = await verifyOAuthState(state, authConfig.jwtSecret);
    } catch {
      return redirectToLogin(origin, 'oauth_failed');
    }

    if (stateResult.nonce !== storedNonce) {
      return redirectToLogin(origin, 'oauth_failed');
    }

    // F-A2-A7-001, single-use burn at rest. The state JWT's `jti`
    // is recorded in `oauth_state_used`; subsequent verifies of the
    // same JWT collide on the primary key and bail. Closes the
    // replay window that the cookie-only delete pattern leaves open
    // for XSS / browser-clone scenarios. Burns BEFORE the
    // expensive token-exchange + userinfo fetch so a replayed
    // state cannot drive load against Google either.
    const burned = await claimOAuthStateJti(
      db,
      stateResult.jti,
      stateResult.expiresAt,
      stateResult.customerId ?? null,
    );
    if (!burned) {
      // Replay attempt, same `jti` already consumed. Most likely a
      // benign double-click after a slow callback; less benign cases
      // (XSS, browser-clone) make this audit row the forensic
      // signal that pages oncall.
      await auditOAuthEvent(
        db,
        ctx,
        'replay_blocked',
        {
          provider: 'google',
          jti: stateResult.jti,
          mode: stateResult.mode,
        },
        stateResult.customerId !== undefined
          ? { customerId: stateResult.customerId }
          : {},
      );
      return redirectToLogin(origin, 'oauth_failed');
    }

    const { mode } = stateResult;

    // --- 3. Exchange code for tokens, PKCE verifier travels back
    //        from the state JWT so Google can validate the
    //        challenge it stored at initiate-time.
    const tokens = await exchangeGoogleCode(code, stateResult.pkceVerifier, customerConfig);

    // --- 4. Fetch user info ---
    const googleUser = await fetchGoogleUserInfo(tokens.accessToken);

    if (!googleUser.email || !googleUser.emailVerified) {
      return mode === 'link'
        ? redirectToSettings(origin, 'google_link_failed')
        : redirectToLogin(origin, 'oauth_failed');
    }

    // --- 5. Check blacklist ---
    const emailHash = createHash('sha256').update(googleUser.email.toLowerCase().trim()).digest('hex');
    const blacklisted = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
    );
    const blacklistRow = blacklisted.rows[0] as { count: string } | undefined;
    if (parseInt(blacklistRow?.count ?? '0', 10) > 0) {
      return mode === 'link'
        ? redirectToSettings(origin, 'google_link_failed')
        : redirectToLogin(origin, 'oauth_failed');
    }

    // =====================================================================
    // LINK MODE, attach Google to existing logged-in customer
    // =====================================================================
    if (mode === 'link') {
      // customerId was embedded in the state JWT during initiate (same-origin POST).
      // We do NOT read the cookie here because SameSite=Strict cookies are not sent
      // on cross-origin redirects from Google.
      if (!stateResult.customerId) {
        return redirectToSettings(origin, 'not_authenticated');
      }
      return await handleLinkMode(
        db, origin, ctx, googleUser, stateResult.customerId,
      );
    }

    // =====================================================================
    // LOGIN MODE, standard login / register flow
    // =====================================================================

    // --- 6a. Check if linked account exists ---
    const linked = await findLinkedAccount(db, 'google', googleUser.sub);
    if (linked) {
      // F-A1-AUDIT-ATOMIC-001 (Path-B): single-session-rotate +
      // success audit commit / roll back together. A mid-audit
      // failure would otherwise leave the user signed in with no
      // forensic trail of the OAuth login.
      const loginResult = await db.transaction(async (tx) => {
        const inner = await loginViaOAuth(tx, authConfig, customerConfig, linked.customerId, ctx);

        await auditOAuthEvent(tx, ctx, 'success', {
          provider: 'google',
          googleSub: googleUser.sub,
          sessionId: inner.sessionId,
        }, { customerId: linked.customerId });

        return inner;
      });

      return buildLoginRedirect(
        origin,
        loginResult,
        authConfig,
        customerConfig,
        isProduction,
        stateResult.continueTo,
      );
    }

    // --- 6b. Check if customer exists with this email ---
    //         F-A2-C2-001 (P2): silent auto-link is removed. A
    //         compromised Google account would otherwise become an
    //         instant-takeover vector against an existing Crivacy
    //         account, the previous design trusted Google's
    //         `email_verified` claim alone. Now we mint a 10-min
    //         confirm-link token and redirect the user to a page
    //         that demands `currentPassword` before committing the
    //         link. GitHub / Microsoft Entra B2C / Auth0 all gate
    //         account-merge with the same explicit reauth.
    const existingCustomer = await findCustomerByEmail(db, googleUser.email);
    if (existingCustomer) {
      const confirmToken = await signConfirmLinkToken(authConfig.jwtSecret, {
        customerId: existingCustomer.id,
        googleSub: googleUser.sub,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
      });
      return redirectToConfirmLink(confirmToken, stateResult.continueTo);
    }

    // --- 6c. Brand new user → create account directly ---
    // Google already provides verified email + display name. No need
    // for a separate completion page, create the customer and login.
    const displayName = googleUser.name ?? googleUser.email.split('@')[0] ?? 'User';

    // F-A1-AUDIT-ATOMIC-001 (Path-B): customer INSERT + link write
    // + session creation + register audit commit / roll back as
    // one. Closes the half-state where a customer row is created
    // without a linked account, or with a session but no audit
    // trail of the OAuth-driven registration. The sub_collision
    // sentinel survives the catch, it is an empty-state error,
    // and the failed-branch audit must use the top-level handle
    // since the tx is already aborted.
    let registerOutcome:
      | {
          kind: 'ok';
          login: Awaited<ReturnType<typeof loginViaOAuth>>;
          customerId: string;
        }
      | { kind: 'sub_collision'; customerId: string };
    try {
      registerOutcome = await db.transaction(async (tx) => {
        const insertResult = await tx.execute<{ id: string }>(
          sql`INSERT INTO customers (email, display_name, status, kyc_level, kyc_score, email_verified_at, created_at, updated_at)
           VALUES (${googleUser.email.trim()}, ${displayName}, 'active', 'kyc_0', 0, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()})
           RETURNING id`,
        );
        const insertedRow = insertResult.rows[0] as { id: string } | undefined;
        if (!insertedRow) {
          throw new _OAuthRegisterAbort();
        }

        // Link Google account. ON CONFLICT DO NOTHING means a sub
        // collision (extremely rare race against another in-flight
        // callback) returns null; the customer row was just inserted so
        // this should never fire, surface the rollback path instead
        // of leaving an orphaned customer row with no linked account.
        const newLinkedId = await createLinkedAccount(
          tx,
          insertedRow.id,
          'google',
          googleUser.sub,
          googleUser.email,
          googleUser.name,
        );
        if (newLinkedId === null) {
          throw new _OAuthSubCollisionAbort(insertedRow.id);
        }

        // Login
        const newUserLogin = await loginViaOAuth(tx, authConfig, customerConfig, insertedRow.id, ctx);

        await writeAudit(tx, {
          action: 'customer.google_registered',
          actor: systemActor('customer-auth'),
          target: uuidTarget({ kind: 'customer', id: insertedRow.id }),
          context: auditCtx,
          meta: { customerId: insertedRow.id, provider: 'google', googleSub: googleUser.sub, email: googleUser.email },
          ts: ctx.now,
        });

        return { kind: 'ok' as const, login: newUserLogin, customerId: insertedRow.id };
      });
    } catch (txErr) {
      if (txErr instanceof _OAuthSubCollisionAbort) {
        await auditOAuthEvent(db, ctx, 'sub_collision', {
          provider: 'google',
          googleSub: googleUser.sub,
          path: 'register_brand_new',
        }, { customerId: txErr.customerId });
        return redirectToLogin(origin, 'oauth_failed');
      }
      if (txErr instanceof _OAuthRegisterAbort) {
        return redirectToLogin(origin, 'oauth_failed');
      }
      throw txErr;
    }

    if (registerOutcome.kind !== 'ok') {
      return redirectToLogin(origin, 'oauth_failed');
    }
    const newUserLogin = registerOutcome.login;
    const customerRow = { id: registerOutcome.customerId };

    // Welcome email (best-effort)
    try {
      const emailContent = welcomeEmail({
        displayName,
        loginUrl: `${getAppUrl()}/login`,
      });
      await enqueueEmailFromRoute(db, {
        to: googleUser.email,
        content: emailContent,
        emailType: 'welcome',
        userId: customerRow.id,
      });
    } catch (emailErr) {
      getRootLogger().error(
        {
          event: 'google_callback_welcome_email_enqueue_failed',
          err: emailErr instanceof Error
            ? { name: emailErr.name, message: emailErr.message }
            : String(emailErr),
        },
        'google-callback: failed to enqueue welcome email',
      );
    }

    return buildLoginRedirect(
      origin,
      newUserLogin,
      authConfig,
      customerConfig,
      isProduction,
      stateResult.continueTo,
    );
  } catch (err) {
    // Status invariant failures (account_banned / account_suspended /
    // account_locked / invalid_credentials from a soft-deleted row)
    // surface their specific code to the login page so the user sees
    // an actionable message instead of a generic OAuth failure. The
    // Google IdP claim is the credential-proof equivalent, same
    // policy as the password-login post-verify branch.
    const customerErr = isCustomerError(err) ? err : null;
    const auditMeta: Record<string, unknown> = {
      provider: 'google',
      reason: 'exception',
      error: err instanceof Error ? err.message : 'unknown',
    };
    if (customerErr !== null) auditMeta['code'] = customerErr.code;
    await auditOAuthEvent(db, ctx, 'failed', auditMeta);

    // Try to determine mode from state to redirect appropriately
    const stateParam = request.nextUrl.searchParams.get('state');
    if (stateParam) {
      try {
        const parsed = await verifyOAuthState(stateParam, authConfig.jwtSecret);
        if (parsed.mode === 'link') {
          return redirectToSettings(origin, 'google_link_failed');
        }
      } catch { /* state invalid, fall through to login redirect */ }
    }
    return redirectToLogin(
      origin,
      customerErr !== null ? mapCustomerCodeToReason(customerErr) : 'oauth_failed',
    );
  }
}

/**
 * Map a {@link CustomerError} thrown by `assertCustomerActive` to the
 * `?error=` value the login page handles. Codes the page does not
 * recognise collapse to `oauth_failed` so the UX stays sane during
 * the (unlikely) event of a new code shipping without a UI update.
 */
function mapCustomerCodeToReason(err: CustomerError): string {
  switch (err.code) {
    case 'account_banned':
    case 'account_suspended':
    case 'account_locked':
      return err.code;
    default:
      return 'oauth_failed';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a themed HTML bounce page with a loading spinner.
 *
 * Uses a `<meta http-equiv="refresh">` for the actual navigation
 * rather than an inline `<script>` so the bounce works under any
 * `script-src` CSP, including our nonce-only policy (`'self'
 * 'nonce-XXX' 'strict-dynamic'`). The inline-script approach was
 * tried twice and abandoned (BUG #48, 2026-04-26):
 *
 *   1st attempt: read middleware's `x-nonce` request header, Edge →
 *   Node runtime hand-off occasionally returned an empty string in
 *   dev, leaving `<script nonce="">` blocked.
 *
 *   2nd attempt: route handler minted its own nonce + a self-
 *   contained `Content-Security-Policy` response header. Compiled
 *   output had `const nonce` shadowed/renamed by SWC, but more
 *   fundamentally Next 15's edge middleware CSP value still
 *   dominated the response (the route's CSP header was overridden,
 *   not the other way round) so the browser saw the middleware
 *   nonce and blocked our inline script's mismatched one.
 *
 * Meta refresh sidesteps both, the navigation is a `<meta>` tag
 * in `<head>`, not subject to `script-src`, and browsers treat it
 * as a same-document-replacing navigation that includes
 * SameSite=Strict cookies (the original reason for the bounce
 * page over a 302 was that 302 lost SameSite=Strict cookies after
 * Google's cross-origin redirect; meta refresh is treated by the
 * URL parser as a fresh same-origin navigation, so the cookie
 * makes it through).
 *
 * `targetUrl` is HTML-escaped before embedding in the `content`
 * attribute since `&` or `"` could otherwise break out of the
 * meta tag. The route only ever passes either `'/'`, a same-
 * origin `safeContinue` path, or a fixed `/settings/security?…`
 * query, but defense-in-depth costs nothing here.
 */
function buildBounceHtml(targetUrl: string, label: string): string {
  const safe = targetUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${safe}"><title>${label}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#a1a1aa;font-family:system-ui,-apple-system,sans-serif}.s{width:32px;height:32px;border:3px solid #27272a;border-top-color:#10b981;border-radius:50%;animation:r .8s linear infinite;margin:0 auto 16px}@keyframes r{to{transform:rotate(360deg)}}p{font-size:14px}</style></head><body><div style="text-align:center"><div class="s"></div><p>${label}</p></div></body></html>`;
}

function redirectToLogin(origin: string, reason: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(reason)}`, origin),
    { status: 302 },
  );
}

/**
 * F-A2-C2-001 confirm-link redirect: bounce HTML (cookie-friendly,
 * see `buildBounceHtml` rationale) into the same-origin confirm-
 * link page where the user supplies their current password before
 * the link is committed. The token is a 10-min HS256 JWT carrying
 * customer ID + Google sub + email; the confirm-link endpoint
 * re-validates the customer row before linking.
 *
 * `continueTo` (if supplied) is forwarded verbatim, the
 * confirm-link endpoint will re-validate same-origin shape before
 * using it as the post-link redirect. URL-token transport is OK
 * here because the token is short-lived (10 min) and the post-link
 * endpoint burns the consumed token's `jti` (handled in step 8 by
 * `oauth_state_used` reuse) so even a logged URL cannot replay.
 */
function redirectToConfirmLink(token: string, continueTo: string | undefined): NextResponse {
  const tokenParam = encodeURIComponent(token);
  const continueParam =
    typeof continueTo === 'string' && continueTo.length > 0
      ? `&continue=${encodeURIComponent(continueTo)}`
      : '';
  const targetUrl = `/confirm-link?t=${tokenParam}${continueParam}`;
  const html = buildBounceHtml(targetUrl, 'Confirming your Crivacy account…');
  const response = new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  // Burn the OAuth nonce, the confirm-link page is a fresh trust
  // boundary and must not depend on the OAuth state cookie still
  // being valid.
  response.cookies.delete(OAUTH_NONCE_COOKIE);
  return response;
}

/**
 * Return an HTML bounce page instead of a 302 redirect.
 *
 * Why: After Google's cross-origin redirect, SameSite=Strict cookies are NOT
 * sent on subsequent 302 redirects (browser still considers the navigation
 * cross-origin). A JS `window.location.replace()` starts a fresh same-origin
 * navigation, so the auth cookie is available and the middleware lets it through.
 */
function redirectToSettings(_origin: string, result: string): NextResponse {
  const targetUrl = `/settings/security?google=${encodeURIComponent(result)}`;
  const html = buildBounceHtml(targetUrl, 'Redirecting\u2026');

  const response = new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  response.cookies.delete(OAUTH_NONCE_COOKIE);
  return response;
}

/**
 * Handle link mode: attach Google account to currently logged-in customer.
 *
 * The customerId comes from the signed state JWT (embedded during initiate when
 * the same-origin POST had access to SameSite=Strict cookies). We do NOT read
 * the access cookie here because cross-origin redirects from Google don't send it.
 */
async function handleLinkMode(
  db: CrivacyDatabase,
  origin: string,
  ctx: { ip: string | null; userAgent: string | null; now: Date; requestId: string },
  googleUser: Awaited<ReturnType<typeof fetchGoogleUserInfo>>,
  customerId: string,
): Promise<NextResponse> {
  // --- 1. Verify customer still exists and is active. Fetch email +
  //         display_name in the same SELECT so the post-link email
  //         leg (F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004) does not need a
  //         second roundtrip.
  const customerCheck = await db.execute<{
    status: string;
    email: string | null;
    display_name: string | null;
  }>(
    sql`SELECT status, email, display_name FROM customers WHERE id = ${customerId} AND deleted_at IS NULL LIMIT 1`,
  );
  const cRow = customerCheck.rows[0] as
    | { status: string; email: string | null; display_name: string | null }
    | undefined;
  if (!cRow || cRow.status === 'suspended') {
    return redirectToSettings(origin, 'not_authenticated');
  }

  // --- 2. Check if Google account is already linked ---
  const existingLink = await findLinkedAccount(db, 'google', googleUser.sub);

  if (existingLink) {
    if (existingLink.customerId === customerId) {
      // Already linked to this customer, idempotent success
      return redirectToSettings(origin, 'linked');
    }
    // Linked to another customer
    return redirectToSettings(origin, 'google_already_linked');
  }

  // --- 3. Link Google account to this customer ---
  // Google link is purely an auth method, does NOT touch customers.email.
  // Email management is a separate flow (Add Email / Change Email).
  // ON CONFLICT DO NOTHING + RETURNING (F-A2-AG-001): we already
  // pre-checked `existingLink` above, so a null here means a race
  // landed another link first, surface as the same UX as the
  // checked branch.
  //
  // F-A1-AUDIT-ATOMIC-001 (Path-B): link write + account_linked
  // audit commit / roll back together. Sentinel for the
  // ON CONFLICT DO NOTHING null branch, emit sub_collision audit
  // outside the rolled-back tx.
  let linkOutcome: 'ok' | 'sub_collision';
  try {
    linkOutcome = await db.transaction(async (tx) => {
      const linkedAccountId = await createLinkedAccount(
        tx,
        customerId,
        'google',
        googleUser.sub,
        googleUser.email,
        googleUser.name,
      );
      if (linkedAccountId === null) {
        throw new _OAuthSubCollisionAbort(customerId);
      }

      await auditOAuthEvent(tx, ctx, 'account_linked', {
        provider: 'google',
        googleSub: googleUser.sub,
        linkedFromSettings: true,
      }, { customerId });

      return 'ok' as const;
    });
  } catch (txErr) {
    if (txErr instanceof _OAuthSubCollisionAbort) {
      await auditOAuthEvent(db, ctx, 'sub_collision', {
        provider: 'google',
        googleSub: googleUser.sub,
        path: 'link_mode',
      }, { customerId });
      return redirectToSettings(origin, 'google_already_linked');
    }
    throw txErr;
  }

  if (linkOutcome !== 'ok') {
    return redirectToSettings(origin, 'google_already_linked');
  }

  // F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004, fire the user-facing
  // "Google linked" email leg via the outbox. Outside the
  // createLinkedAccount tx so a notification failure does not roll
  // back the link itself; the audit row already exists via
  // auditOAuthEvent('account_linked'). Customer with no email on file
  // (wallet-only edge) silently skips the email.
  if (cRow.email !== null) {
    await emitSecurityEvent({
      db,
      eventType: 'customer.google_linked',
      subject: { kind: 'customer', id: customerId },
      payload: {
        auditContext: {
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        },
        email: cRow.email,
        displayName:
          cRow.display_name ?? cRow.email.split('@')[0] ?? 'there',
        provider: 'google',
        eventKind: 'added',
      },
      now: ctx.now,
    });
  }

  return redirectToSettings(origin, 'linked');
}

interface OAuthLoginResult {
  readonly customerId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  readonly rememberMe: boolean;
}

/**
 * Create a session for a customer via OAuth (no password check).
 * Revokes all existing sessions (single session enforcement).
 *
 * Page 1 H.1-H.4 parite (F-A2-H1-001 P1): banned / suspended / locked
 * / soft-deleted customers cannot sign in via Google any more than
 * via email+password. The IdP's verified-email claim is equivalent
 * to a password proof, we already know the caller controls the
 * Google identity, so surfacing precise codes is safe and gives the
 * UI an actionable message instead of a generic "OAuth failed" toast.
 */
async function loginViaOAuth(
  db: CrivacyDatabase,
  authConfig: AuthConfig,
  customerConfig: CustomerAuthConfig,
  customerId: string,
  ctx: { ip: string | null; userAgent: string | null; now: Date },
): Promise<OAuthLoginResult> {
  const now = ctx.now;

  // Status invariant, single source of truth shared with
  // `loginCustomer`. Throws CustomerError on banned / suspended /
  // locked; outer GET handler maps to a redirect carrying the
  // specific code so the login page can toast accordingly.
  await assertCustomerActive(db, customerId, customerConfig, now);

  // Update last_login_at
  await db.execute(
    sql`UPDATE customers SET last_login_at = ${now.toISOString()}, updated_at = ${now.toISOString()} WHERE id = ${customerId}`,
  );

  // Revoke all existing sessions (single session enforcement)
  await db.execute(
    sql`UPDATE customer_sessions
     SET revoked_at = ${now.toISOString()}, revoked_reason = 'superseded_by_new_login'
     WHERE customer_id = ${customerId} AND revoked_at IS NULL`,
  );

  // Sign access token
  const signed = await signAccessToken(
    { kind: 'customer', sub: customerId, role: 'customer' },
    authConfig,
    now,
  );

  // Generate refresh token (remember me = true for OAuth)
  const refresh = generateRefreshToken();
  const refreshTtlSeconds = customerConfig.customerRememberMeTtlDays * 86400;
  const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

  // Create session
  const sessionResult = await db.execute<{ id: string }>(
    sql`INSERT INTO customer_sessions
     (customer_id, jwt_jti, refresh_token_hash, refresh_token_version, ip, user_agent, device_name, remember_me, issued_at, expires_at, refresh_expires_at, last_active_at, created_at)
     VALUES (${customerId}, ${signed.jti}, ${refresh.tokenHash}, 1, ${ctx.ip}, ${ctx.userAgent}, ${parseDeviceName(ctx.userAgent)}, true, ${now.toISOString()}, ${signed.expiresAt.toISOString()}, ${refreshExpiresAt.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
     RETURNING id`,
  );
  const sessionRow = sessionResult.rows[0] as { id: string } | undefined;
  if (!sessionRow) {
    throw new Error('Failed to create customer session');
  }

  return {
    customerId,
    accessToken: signed.token,
    refreshToken: refresh.token,
    accessTokenExpiresAt: signed.expiresAt,
    refreshTokenExpiresAt: refreshExpiresAt,
    sessionId: sessionRow.id,
    rememberMe: true,
  };
}

/**
 * Build a response that sets auth cookies and sends user to /.
 *
 * Uses an HTML bounce page instead of a 302 redirect. After Google's
 * cross-origin redirect the browser still considers the navigation
 * cross-site, so SameSite=Strict cookies are NOT sent on a subsequent
 * 302. A `window.location.replace()` starts a fresh same-origin
 * navigation where the cookie IS available to the middleware.
 */
function buildLoginRedirect(
  _origin: string,
  result: OAuthLoginResult,
  authConfig: AuthConfig,
  customerConfig: CustomerAuthConfig,
  isProduction: boolean,
  continueTo?: string,
): NextResponse {
  // `continueTo` was validated same-origin when embedded in the
  // state JWT at initiate-time. Still re-assert here as a
  // belt-and-suspenders gate, the JWT could theoretically be
  // forged with a matching secret, and a single-slash-prefixed
  // path is cheap to verify.
  const safeContinue =
    typeof continueTo === 'string' &&
    continueTo.length > 0 &&
    continueTo.startsWith('/') &&
    !continueTo.startsWith('//')
      ? continueTo
      : '/';
  const targetUrl = safeContinue;
  const html = buildBounceHtml(targetUrl, 'Signing you in\u2026');

  const response = new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

  // Access token cookie
  response.cookies.set(ACCESS_TOKEN_COOKIE, result.accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: authConfig.jwtAccessTtlSeconds,
  });

  // Refresh token cookie (always persistent for OAuth)
  response.cookies.set(REFRESH_TOKEN_COOKIE, result.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/customer/auth/refresh',
    maxAge: customerConfig.customerRememberMeTtlDays * 86400,
  });

  // Clear nonce cookie
  response.cookies.delete(OAUTH_NONCE_COOKIE);

  return response;
}

/**
 * Sentinel, `INSERT INTO customers ... RETURNING id` returned no
 * row. Throws to roll back the brand-new register tx so the caller
 * can surface a generic OAuth failure without an audit row.
 */
class _OAuthRegisterAbort extends Error {
  constructor() {
    super('oauth_register_insert_returned_empty');
    this.name = '_OAuthRegisterAbort';
  }
}

/**
 * Sentinel, `createLinkedAccount` returned null inside an OAuth
 * tx (ON CONFLICT DO NOTHING race). Throws so the tx rolls back;
 * the caller emits the `sub_collision` audit on the top-level db
 * handle. Carries the customer id so the failed-branch audit row
 * still targets the right principal.
 */
class _OAuthSubCollisionAbort extends Error {
  readonly customerId: string;
  constructor(customerId: string) {
    super('oauth_sub_collision_in_tx');
    this.name = '_OAuthSubCollisionAbort';
    this.customerId = customerId;
  }
}
