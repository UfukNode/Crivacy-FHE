/**
 * POST /api/customer/auth/google/confirm-link
 *
 * F-A2-C2-001 (P2): consume the 10-min confirm-link token minted by
 * the OAuth callback's auto-link branch, demand a password reauth,
 * and only then create the `customer_linked_accounts` row + sign in.
 *
 * Threat model: silent auto-link (the previous behaviour) gave any
 * party who briefly controlled a Google account with the same
 * verified email instant takeover access to a Crivacy account. This
 * endpoint forces the legitimate owner to prove they still know the
 * Crivacy password before the link is committed, mirroring
 * GitHub / Microsoft Entra B2C / Auth0 account-merge flows.
 *
 * Wallet-only customers (email present, no password) are rejected
 * with `password_required`, they must sign in via wallet and link
 * Google from `/settings/security` instead. Magic-link-via-email
 * fallback is an alt-batch follow-up.
 */

import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { signAccessToken, generateRefreshToken } from '@/lib/auth/jwt';
import { parseDeviceName } from '@/lib/auth/device-name';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { verifyConfirmLinkToken } from '@/lib/customer/google-oauth';
import { createLinkedAccount, findLinkedAccount } from '@/lib/customer/linked-accounts';
import { claimOAuthStateJti } from '@/lib/customer/oauth-state-burn';
import { assertCustomerActive } from '@/lib/customer/status-check';
import { CustomerError, isCustomerError } from '@/lib/customer/errors';
import { existingPasswordSchema } from '@/lib/validation/auth';
import { sanitizeSameOriginPath } from '@/lib/security/safe-redirect';

import { auditOAuthEvent } from '@/lib/customer/audit-oauth';
import { emitSecurityEvent } from '@/lib/security-events';

import {
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
} from '@/lib/auth/cookie-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;

const ConfirmBody = z.object({
  token: z.string().min(1).max(2048),
  currentPassword: existingPasswordSchema,
  // Optional same-origin path to land on after success, re-validated
  // here so a tampered token cannot redirect to an arbitrary host.
  continueTo: z.string().min(1).max(512).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);
  const authConfig = getAuthConfig();
  const customerConfig = getCustomerAuthConfig();
  const isProduction = process.env.NODE_ENV === 'production';
  const now = ctx.now;

  // Per-IP rate limit, re-uses the initiate cap shape because the
  // confirm-link surface is similar (one user-driven attempt per
  // login flow).
  const limited = await maybeRateLimitResponse(db, 'customer_oauth_initiate', ctx.ip, now);
  if (limited) return limited;

  try {
    const body = await parseBody(request, ConfirmBody);

    // 1. Verify the confirm-link token.
    let payload;
    try {
      payload = await verifyConfirmLinkToken(body.token, authConfig.jwtSecret);
    } catch {
      return ctx.errorJson(
        'invalid_verification_token',
        'This confirmation link has expired or is no longer valid. Please start the Google sign-in flow again.',
        401,
      );
    }

    // 1a. Burn the token's `jti` (F-A2-A7-001). A logged URL or
    //     browser-history snapshot of the confirm-link page would
    //     otherwise be replayable for the full TTL, even with the
    //     correct password. Burn-at-rest closes that gap. Same
    //     primitive (`oauth_state_used` PK) used by the callback.
    const burned = await claimOAuthStateJti(
      db,
      payload.jti,
      payload.expiresAt,
      payload.customerId,
    );
    if (!burned) {
      await auditOAuthEvent(db, ctx, 'replay_blocked', {
        provider: 'google',
        jti: payload.jti,
        path: 'confirm_link',
      }, { customerId: payload.customerId });
      return ctx.errorJson(
        'invalid_verification_token',
        'This confirmation link has already been used.',
        401,
      );
    }

    // 2. Re-assert the customer is still permitted to sign in. The
    //    token was minted up to 10 minutes ago; an admin could have
    //    suspended / banned in the interim.
    await assertCustomerActive(db, payload.customerId, customerConfig, now);

    // 3. Reauth: the password is the proof that the caller actually
    //    owns this Crivacy account, not just a Google account that
    //    happens to share an email.
    const reauth = await reauthGate({
      db,
      subject: { kind: 'customer', id: payload.customerId },
      password: body.currentPassword,
      factor: { type: 'none' },
      now,
      authConfig,
    });
    if (reauth.status === 'failed') {
      const mapped = reauthFailureResponse(reauth.reason);
      return ctx.errorJson(mapped.code, mapped.message, mapped.status);
    }

    // 4. If a different Google sub is already linked to this
    //    customer, refuse, the user should unlink the old Google
    //    first via /settings/security. Mirrors handleLinkMode UX.
    const existingGoogleLink = await findLinkedAccount(db, 'google', payload.googleSub);
    if (existingGoogleLink !== null && existingGoogleLink.customerId !== payload.customerId) {
      await auditOAuthEvent(db, ctx, 'sub_collision', {
        provider: 'google',
        googleSub: payload.googleSub,
        path: 'confirm_link_existing_owner',
      }, { customerId: payload.customerId });
      return ctx.errorJson(
        'oauth_failed',
        'This Google account is already linked to a different Crivacy account.',
        409,
      );
    }

    // F-A1-AUDIT-ATOMIC-001 (Path-B Pattern A-in-tx): the entire
    // login intent (link write + status promote + session
    // rotation + summary audits) commits / rolls back as one. A
    // mid-flow audit failure must not leave a customer linked +
    // promoted + signed-in without the matching forensic trail.
    // sub_collision throws a sentinel so the (audit-only) error
    // branch can fire on the top-level db handle after the tx is
    // already aborted.
    let txOutcome:
      | { kind: 'ok'; signed: Awaited<ReturnType<typeof signAccessToken>>; refresh: ReturnType<typeof generateRefreshToken>; refreshExpiresAt: Date }
      | { kind: 'sub_collision' };
    try {
      txOutcome = await db.transaction(async (tx) => {
        // 5. Create the link. ON CONFLICT DO NOTHING + null surfaces
        //    a race or pre-existing different sub on this customer.
        const linkedId = await createLinkedAccount(
          tx,
          payload.customerId,
          'google',
          payload.googleSub,
          payload.email,
          payload.name,
        );
        if (linkedId === null) {
          throw new _SubCollisionAbort();
        }

        // 6. Capture pre-update status so we can emit `status_promoted`
        //    only when the CASE expression actually flips the row.
        const beforeStatus = await tx.execute<{ status: string }>(
          sql`SELECT status FROM customers WHERE id = ${payload.customerId} LIMIT 1`,
        );
        const wasPending = beforeStatus.rows[0]?.status === 'pending_verification';

        // F-A2-C8-001: `display_name` uses COALESCE so a wallet-with-
        // email customer who never set a name gets one from Google, but
        // a customer who already chose a `display_name` keeps it
        // (initial-only invariant, matches GitHub / Stripe / Atlassian).
        await tx.execute(
          sql`UPDATE customers
           SET email_verified_at = COALESCE(email_verified_at, ${now.toISOString()}),
               status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END,
               display_name = COALESCE(display_name, ${payload.name}),
               updated_at = ${now.toISOString()}
           WHERE id = ${payload.customerId}`,
        );

        if (wasPending) {
          await auditOAuthEvent(tx, ctx, 'status_promoted', {
            provider: 'google',
            fromStatus: 'pending_verification',
            toStatus: 'active',
          }, { customerId: payload.customerId });
        }

        // 7. Sign access token + create session (cookie path).
        const signed = await signAccessToken(
          { kind: 'customer', sub: payload.customerId, role: 'customer' },
          authConfig,
          now,
        );
        const refresh = generateRefreshToken();
        const refreshTtlSeconds = customerConfig.customerRememberMeTtlDays * 86400;
        const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

        // Revoke prior sessions (single-session enforcement parite).
        await tx.execute(
          sql`UPDATE customer_sessions
           SET revoked_at = ${now.toISOString()}, revoked_reason = 'superseded_by_new_login'
           WHERE customer_id = ${payload.customerId} AND revoked_at IS NULL`,
        );

        await tx.execute(
          sql`INSERT INTO customer_sessions
           (customer_id, jwt_jti, refresh_token_hash, refresh_token_version, ip, user_agent, device_name, remember_me, issued_at, expires_at, refresh_expires_at, last_active_at, created_at)
           VALUES (${payload.customerId}, ${signed.jti}, ${refresh.tokenHash}, 1, ${ctx.ip}, ${ctx.userAgent}, ${parseDeviceName(ctx.userAgent)}, true, ${now.toISOString()}, ${signed.expiresAt.toISOString()}, ${refreshExpiresAt.toISOString()}, ${now.toISOString()}, ${now.toISOString()})`,
        );

        // 8. Audit, link write + login success in one logical event
        //    sequence so the forensic trail shows "user confirmed link
        //    + signed in" as a single intent.
        await auditOAuthEvent(tx, ctx, 'account_linked', {
          provider: 'google',
          googleSub: payload.googleSub,
          autoLinked: false,
          confirmed: true,
        }, { customerId: payload.customerId });

        await auditOAuthEvent(tx, ctx, 'success', {
          provider: 'google',
          googleSub: payload.googleSub,
          sessionJti: signed.jti,
          path: 'confirm_link',
        }, { customerId: payload.customerId });

        return { kind: 'ok' as const, signed, refresh, refreshExpiresAt };
      });
    } catch (txErr) {
      if (txErr instanceof _SubCollisionAbort) {
        await auditOAuthEvent(db, ctx, 'sub_collision', {
          provider: 'google',
          googleSub: payload.googleSub,
          path: 'confirm_link_insert_conflict',
        }, { customerId: payload.customerId });
        return ctx.errorJson(
          'oauth_failed',
          'Could not link Google to this account. Please retry from /settings/security.',
          409,
        );
      }
      throw txErr;
    }

    if (txOutcome.kind !== 'ok') {
      // Defensive, the only non-ok branch is `sub_collision`, which
      // is handled by the catch above. Keeps the type narrow.
      return ctx.errorJson('oauth_failed', 'Unexpected OAuth state.', 500);
    }
    const { signed, refresh, refreshExpiresAt } = txOutcome;

    // F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004, fire the user-facing
    // "Google linked" email leg via the outbox. Outside the
    // tx so a notification failure does not roll back the link
    // commit + session creation; the audit row already lives via
    // auditOAuthEvent('account_linked'). `payload.email` is the
    // Google IdP email which equals the matched customer.email by
    // construction (link token is minted only when those match).
    await emitSecurityEvent({
      db,
      eventType: 'customer.google_linked',
      subject: { kind: 'customer', id: payload.customerId },
      payload: {
        auditContext: {
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        },
        email: payload.email,
        displayName: payload.name ?? payload.email.split('@')[0] ?? 'there',
        provider: 'google',
        eventKind: 'added',
      },
      now,
    });

    // 9. Compose the response with cookies. The page redirects via
    //    `router.push(redirect)` after we return.
    const safeContinue =
      typeof body.continueTo === 'string' && body.continueTo.length > 0
        ? sanitizeSameOriginPath(body.continueTo)
        : '/';
    const response = NextResponse.json({ ok: true, redirect: safeContinue });
    response.cookies.set(ACCESS_TOKEN_COOKIE, signed.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });
    response.cookies.set(REFRESH_TOKEN_COOKIE, refresh.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/customer/auth/refresh',
      maxAge: customerConfig.customerRememberMeTtlDays * 86400,
    });
    return response;
  } catch (err) {
    if (isParseError(err)) {
      return ctx.errorJson('validation_failed', 'Invalid confirmation request.', 400);
    }
    if (isCustomerError(err)) {
      const status =
        err.code === 'account_locked' || err.code === 'account_suspended'
          ? 403
          : err.code === 'account_banned'
            ? 403
            : 401;
      return ctx.errorJson(err.code, err.message, status);
    }
    throw err;
  }
}

/**
 * Sentinel error used to roll back the confirm-link transaction when
 * `createLinkedAccount` returns null (ON CONFLICT DO NOTHING). The
 * caller catches it and emits the `sub_collision` audit on the
 * top-level db handle instead, the failed-branch audit must not be
 * tied to the rolled-back tx.
 */
class _SubCollisionAbort extends Error {
  constructor() {
    super('confirm_link_sub_collision');
    this.name = '_SubCollisionAbort';
  }
}
