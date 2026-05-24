/**
 * POST /api/customer/auth/wallet/verify
 *
 * Verify an Ethereum wallet signature and authenticate the user.
 *
 * Flow:
 *   1. Verify challenge JWT → extract nonce
 *   2. Verify Ed25519 signature (publicKey + nonce + signature)
 *   3. Blacklist check (wallet_address_hash)
 *   4. Find linked account by ('evm_wallet', walletAddress)
 *      a) Found → single session enforcement → login → set cookies
 *      b) Not found → create new customer (email=null, pwd=null) → link → login
 *   5. Return { redirect: '/' }
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import type { AuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';
import { signAccessToken, generateRefreshToken } from '@/lib/auth/jwt';
import { parseDeviceName } from '@/lib/auth/device-name';
import { buildRequestContext } from '@/server/context';
import { isParseError, parseBody } from '@/server/middleware/parse';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import type { CustomerAuthConfig } from '@/lib/customer/config';
import {
  claimWalletNonce,
  verifyWalletChallenge,
  verifyEvmWalletSignature,
} from '@/lib/customer/evm-wallet';
import {
  findLinkedAccount,
  createLinkedAccount,
} from '@/lib/customer/linked-accounts';
import { isWalletBlacklisted } from '@/lib/fraud/blacklist';
import { CustomerError, isCustomerError } from '@/lib/customer/errors';
import { assertCustomerActive } from '@/lib/customer/status-check';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget, uuidTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

import {
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
} from '@/lib/auth/cookie-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VerifyBody = z.object({
  challenge: z.string().min(1),
  // The full EIP-4361 (SIWE) message the wallet signed. Carries the address,
  // domain, and nonce; the server recovers + verifies the address from it.
  message: z.string().min(1).max(4096),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex')
    .max(4096),
  provider: z.literal('evm_wallet'),
  // Optional post-login landing path. Must be same-origin
  // (leading slash, not protocol-relative). The server
  // re-validates before echoing to the client.
  from: z
    .string()
    .max(2048)
    .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
      message: 'from must be a same-origin absolute path.',
    })
    .optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);
  const authConfig = getAuthConfig();
  const customerConfig = getCustomerAuthConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  const auditCtx = buildAuditContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });

  try {
    const body = await parseBody(request, VerifyBody);

    // Debug-level dev diagnostic, suppressed under default `info`
    // prod log level. Developer enables `LOG_LEVEL=debug` to see
    // signature / pubkey length shape when troubleshooting wallet
    // integration locally.
    getRootLogger().debug(
      {
        event: 'wallet_verify_body_received',
        signatureLength: body.signature.length,
        messageLength: body.message.length,
        provider: body.provider,
      },
      'wallet-verify incoming body',
    );

    // --- 1. Verify challenge JWT ---
    let nonce: string;
    try {
      nonce = await verifyWalletChallenge(body.challenge, authConfig.jwtSecret);
    } catch {
      return ctx.errorJson(
        'wallet_challenge_invalid',
        'Challenge expired or invalid. Please request a new one.',
        401,
      );
    }

    getRootLogger().debug(
      { event: 'wallet_verify_challenge_ok', nonce },
      'wallet-verify challenge verified',
    );

    // --- 2. Verify the SIWE signature and recover the EVM address ---
    const address = await verifyEvmWalletSignature({
      message: body.message,
      signature: body.signature as `0x${string}`,
      expectedNonce: nonce,
    });
    if (address === null) {
      await writeAudit(db, {
        action: 'customer.wallet_login_failed',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: {
          provider: body.provider,
          reason: 'invalid_signature',
        },
        ts: ctx.now,
      });
      return ctx.errorJson(
        'wallet_signature_invalid',
        'Wallet signature verification failed.',
        401,
      );
    }

    // --- 2a. Burn the nonce BEFORE any session-creating work.
    //         Closes the replay window: if this same
    //         (challenge JWT, signature) pair is submitted again
    //         inside the JWT's 5-minute TTL, the INSERT collides
    //         and `claimWalletNonce` returns false. An attacker who
    //         intercepts a valid pair (XSS, compromised browser
    //         extension, shared debug logs) can no longer mint a
    //         second session off it.
    const fresh = await claimWalletNonce(db, nonce, ctx.now);
    if (!fresh) {
      await writeAudit(db, {
        action: 'customer.wallet_login_failed',
        actor: systemActor('customer-auth'),
        target: noTarget(),
        context: auditCtx,
        meta: {
          provider: body.provider,
          walletAddress: address.slice(0, 16) + '...',
          reason: 'nonce_replay',
        },
        ts: ctx.now,
      });
      return ctx.errorJson(
        'wallet_challenge_invalid',
        'Challenge has already been used. Please request a new one.',
        401,
      );
    }

    // --- 3. Blacklist check ---
    const blacklisted = await isWalletBlacklisted(db, address);
    if (blacklisted) {
      return ctx.errorJson(
        'wallet_signature_invalid',
        'Wallet signature verification failed.',
        401,
      );
    }

    // --- 4. Look up linked account ---
    const linked = await findLinkedAccount(db, 'evm_wallet', address);

    if (linked) {
      // --- 4a. Existing user → login ---
      // F-A3-H1-001-PRE Page 3 pre-flight parity: route the linked-
      // account branch through the central `assertCustomerActive`
      // gate (F-A2-H1-001) so banned / suspended / locked / soft-
      // deleted state cannot be bypassed via the wallet path while
      // password+OAuth surfaces are correctly gated. Auto-unlock for
      // expired locks happens inside the helper. Map CustomerError
      // codes back to the wallet-specific anti-enumeration response
      // for the soft-delete branch (`invalid_credentials` →
      // `wallet_signature_invalid`).
      try {
        await assertCustomerActive(db, linked.customerId, customerConfig, ctx.now);
      } catch (statusErr) {
        if (isCustomerError(statusErr)) {
          if (statusErr.code === 'invalid_credentials') {
            return ctx.errorJson(
              'wallet_signature_invalid',
              'Wallet signature verification failed.',
              401,
            );
          }
          const status =
            statusErr.code === 'account_banned' || statusErr.code === 'account_suspended'
              ? 403
              : statusErr.code === 'account_locked'
                ? 423
                : 401;
          return ctx.errorJson(statusErr.code, statusErr.message, status);
        }
        throw statusErr;
      }

      const loginResult = await loginViaWallet(
        db,
        authConfig,
        customerConfig,
        linked.customerId,
        ctx,
      );

      await writeAudit(db, {
        action: 'customer.wallet_login',
        actor: systemActor('customer-auth'),
        target: uuidTarget({ kind: 'customer', id: linked.customerId }),
        context: auditCtx,
        meta: { provider: body.provider, walletAddress: address.slice(0, 16) + '...' },
        ts: ctx.now,
      });

      return buildLoginResponse(ctx, loginResult, authConfig, customerConfig, isProduction, body.from);
    }

    // --- 4b. New user → create customer + linked account ---
    const newCustomerResult = await db.execute<{ id: string }>(
      sql`INSERT INTO customers (status, kyc_level, kyc_score, created_at, updated_at)
       VALUES ('active', 'kyc_0', 0, ${ctx.now.toISOString()}, ${ctx.now.toISOString()})
       RETURNING id`,
    );
    const newRow = newCustomerResult.rows[0] as { id: string } | undefined;
    if (!newRow) {
      throw new Error('Failed to create customer');
    }

    // Display name: a truncated EVM address (0x1234…abcd).
    const hint = `${address.slice(0, 6)}…${address.slice(-4)}`;

    // F-A2-AG-001: ON CONFLICT DO NOTHING. Wallet sub collision
    // against the just-created customer is a race against another
    // verify call (same partyId, parallel registrations), surface
    // as wallet_already_linked rather than leave the new customer
    // row orphaned.
    const linkedId = await createLinkedAccount(
      db,
      newRow.id,
      'evm_wallet',
      address,
      null, // no email
      hint,
    );
    if (linkedId === null) {
      throw new CustomerError(
        'wallet_signature_invalid',
        'This wallet is already registered to another account.',
      );
    }

    const loginResult = await loginViaWallet(
      db,
      authConfig,
      customerConfig,
      newRow.id,
      ctx,
    );

    await writeAudit(db, {
      action: 'customer.wallet_registered',
      actor: systemActor('customer-auth'),
      target: uuidTarget({ kind: 'customer', id: newRow.id }),
      context: auditCtx,
      meta: { provider: body.provider, walletAddress: address.slice(0, 16) + '...' },
      ts: ctx.now,
    });

    return buildLoginResponse(ctx, loginResult, authConfig, customerConfig, isProduction, body.from);
  } catch (err) {
    if (isParseError(err)) {
      const status =
        err.code === 'payload_too_large'
          ? 413
          : err.code === 'unsupported_media_type'
            ? 415
            : 400;
      return ctx.errorJson(err.code, err.message, status);
    }
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WalletLoginResult {
  readonly customerId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}

/**
 * Create a session for a customer via wallet (no password check).
 * Revokes all existing sessions (single session enforcement).
 */
async function loginViaWallet(
  db: CrivacyDatabase,
  authConfig: AuthConfig,
  customerConfig: CustomerAuthConfig,
  customerId: string,
  ctx: { ip: string | null; userAgent: string | null; now: Date },
): Promise<WalletLoginResult> {
  const now = ctx.now;

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

  // Generate refresh token (persistent for wallet login)
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
  };
}

/**
 * Build a JSON response with Set-Cookie headers for wallet login.
 * Unlike Google OAuth (which uses redirects), wallet login returns
 * JSON because the frontend handles the flow in JavaScript.
 */
function buildLoginResponse(
  ctx: ReturnType<typeof buildRequestContext>,
  result: WalletLoginResult,
  authConfig: AuthConfig,
  customerConfig: CustomerAuthConfig,
  isProduction: boolean,
  continueTo?: string,
): NextResponse {
  // `continueTo` is already Zod-validated (starts with `/`, not
  // `//`). Defence-in-depth: re-check here so a future schema
  // loosening can't silently leak into an open redirect.
  const safeContinue =
    typeof continueTo === 'string' &&
    continueTo.length > 0 &&
    continueTo.startsWith('/') &&
    !continueTo.startsWith('//')
      ? continueTo
      : '/';
  const response = ctx.json({ redirect: safeContinue });

  // Access token cookie
  response.cookies.set(CUSTOMER_ACCESS_COOKIE, result.accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: authConfig.jwtAccessTtlSeconds,
  });

  // Refresh token cookie (always persistent for wallet)
  response.cookies.set(CUSTOMER_REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/customer/auth/refresh',
    maxAge: customerConfig.customerRememberMeTtlDays * 86400,
  });

  return response;
}
