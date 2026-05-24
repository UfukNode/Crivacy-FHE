/**
 * POST /api/customer/auth/google/complete
 *
 * Complete registration for new Google OAuth users.
 * The user has already authenticated with Google and has a completion
 * token cookie. They must now set a password (and optionally a display name).
 *
 * Flow:
 * 1. Read completion token from cookie → verify → extract Google user info
 * 2. Check blacklist (same as register)
 * 3. Check if email already taken (race condition guard)
 * 4. Hash password
 * 5. Create customer (status=active, email_verified_at=NOW)
 * 6. Create linked account
 * 7. Login (create session, set cookies)
 * 8. Audit + welcome email
 * 9. Clear completion cookie
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { getAppUrl } from '@/lib/env/app-url';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { signAccessToken, generateRefreshToken } from '@/lib/auth/jwt';
import { parseDeviceName } from '@/lib/auth/device-name';
import { buildRequestContext } from '@/server/context';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { isParseError, parseBody } from '@/server/middleware/parse';

import { getCustomerAuthConfig } from '@/lib/customer/config';
import { verifyCompletionToken } from '@/lib/customer/google-oauth';
import { createLinkedAccount } from '@/lib/customer/linked-accounts';

import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { welcomeEmail } from '@/lib/email/templates';
import { newPasswordSchema } from '@/lib/validation/auth';
import { displayNameSchema } from '@/lib/validation/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import {
  GOOGLE_COMPLETION_COOKIE,
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
} from '@/lib/auth/cookie-names';

const COMPLETION_COOKIE = GOOGLE_COMPLETION_COOKIE;
const ACCESS_TOKEN_COOKIE = CUSTOMER_ACCESS_COOKIE;
const REFRESH_TOKEN_COOKIE = CUSTOMER_REFRESH_COOKIE;

const CompleteBody = z.object({
  password: newPasswordSchema,
  displayName: displayNameSchema.optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);
  const authConfig = getAuthConfig();
  const customerConfig = getCustomerAuthConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  try {
    // --- 1. Verify completion token ---
    const completionToken = request.cookies.get(COMPLETION_COOKIE)?.value;
    if (!completionToken) {
      return ctx.errorJson('completion_token_expired', 'Registration session expired. Please try again with Google.', 401);
    }

    let googleUser: Awaited<ReturnType<typeof verifyCompletionToken>>;
    try {
      googleUser = await verifyCompletionToken(completionToken, authConfig.jwtSecret);
    } catch {
      return ctx.errorJson('completion_token_invalid', 'Invalid registration session. Please try again.', 401);
    }

    // --- 2. Parse body ---
    const body = await parseBody(request, CompleteBody);

    // --- 3. Check blacklist ---
    const emailLower = googleUser.email.toLowerCase().trim();
    const emailHash = createHash('sha256').update(emailLower).digest('hex');
    const blacklisted = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
    );
    const blacklistRow = blacklisted.rows[0] as { count: string } | undefined;
    if (parseInt(blacklistRow?.count ?? '0', 10) > 0) {
      // Silent success, same shape
      return buildSuccessResponse(ctx);
    }

    // --- 4. Check duplicate (race condition guard) ---
    const existing = await db.execute<{ id: string }>(
      sql`SELECT id FROM customers WHERE lower(email) = ${emailLower} AND deleted_at IS NULL LIMIT 1`,
    );
    if ((existing.rows[0] as { id: string } | undefined) !== undefined) {
      // Email was taken between callback and completion, return friendly error
      return ctx.errorJson('email_already_registered', 'This email is already registered. Try signing in instead.', 409);
    }

    // --- 5. Reject breached passwords, then hash + create customer ---
    await assertPasswordNotPwned(body.password);
    const passwordHash = await hashPassword(body.password, authConfig);
    const now = ctx.now;
    const displayName = body.displayName?.trim() ?? googleUser.name ?? null;

    const insertResult = await db.execute<{ id: string }>(
      sql`INSERT INTO customers (email, password_hash, display_name, status, kyc_level, kyc_score, email_verified_at, created_at, updated_at)
       VALUES (${googleUser.email.trim()}, ${passwordHash}, ${displayName}, 'active', 'kyc_0', 0, ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
       RETURNING id`,
    );
    const customerRow = insertResult.rows[0] as { id: string } | undefined;
    if (!customerRow) {
      return ctx.errorJson('email_already_registered', 'Registration failed. Please try again.', 409);
    }

    // --- 6. Create linked account. ON CONFLICT DO NOTHING returns
    //        null on a sub-collision race (extremely rare against a
    //        just-created customer row); surface as a 409 rather than
    //        silently leaving an orphaned customer with no link.
    const linkedId = await createLinkedAccount(
      db,
      customerRow.id,
      'google',
      googleUser.sub,
      googleUser.email,
      googleUser.name,
    );
    if (linkedId === null) {
      return ctx.errorJson(
        'oauth_failed',
        'Google account is already linked to a different user.',
        409,
      );
    }

    // --- 7. Login (create session) ---
    // Revoke all existing sessions (should be none for new user, but safe)
    await db.execute(
      sql`UPDATE customer_sessions
       SET revoked_at = ${now.toISOString()}, revoked_reason = 'superseded_by_new_login'
       WHERE customer_id = ${customerRow.id} AND revoked_at IS NULL`,
    );

    const signed = await signAccessToken(
      { kind: 'customer', sub: customerRow.id, role: 'customer' },
      authConfig,
      now,
    );

    const refresh = generateRefreshToken();
    const refreshTtlSeconds = customerConfig.customerRememberMeTtlDays * 86400;
    const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

    const sessionResult = await db.execute<{ id: string }>(
      sql`INSERT INTO customer_sessions
       (customer_id, jwt_jti, refresh_token_hash, refresh_token_version, ip, user_agent, device_name, remember_me, issued_at, expires_at, refresh_expires_at, last_active_at, created_at)
       VALUES (${customerRow.id}, ${signed.jti}, ${refresh.tokenHash}, 1, ${ctx.ip}, ${ctx.userAgent}, ${parseDeviceName(ctx.userAgent)}, true, ${now.toISOString()}, ${signed.expiresAt.toISOString()}, ${refreshExpiresAt.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
       RETURNING id`,
    );
    const sessionRow = sessionResult.rows[0] as { id: string } | undefined;
    if (!sessionRow) {
      throw new Error('Failed to create customer session');
    }

    // --- 8. Audit + welcome email ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    await writeAudit(db, {
      action: 'customer.google_registered',
      actor: systemActor('customer-auth'),
      target: noTarget(),
      context: auditCtx,
      meta: { customerId: customerRow.id, provider: 'google', googleSub: googleUser.sub, email: googleUser.email },
      ts: ctx.now,
    });

    const emailContent = welcomeEmail({
      displayName: displayName ?? googleUser.email.split('@')[0] ?? 'User',
      loginUrl: `${getAppUrl()}/login`,
    });
    await enqueueEmailFromRoute(db, {
      to: googleUser.email,
      content: emailContent,
      emailType: 'welcome',
      userId: customerRow.id,
    });

    // --- 9. Build response with cookies ---
    const response = NextResponse.json(
      { customerId: customerRow.id },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

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

    // Clear completion cookie
    response.cookies.delete(COMPLETION_COOKIE);

    return response;
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

function buildSuccessResponse(ctx: { json: (body: unknown, status: number) => NextResponse }): NextResponse {
  return ctx.json({ customerId: null }, 200);
}
