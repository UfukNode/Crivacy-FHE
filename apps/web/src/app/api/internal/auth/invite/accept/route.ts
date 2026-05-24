/**
 * POST /api/internal/auth/invite/accept
 *
 * Public endpoint that finalises a firm-user invitation: hashes the
 * chosen password, encrypts + persists the TOTP secret, burns the
 * single-use token, revokes any stale sessions, and issues a fresh
 * access + refresh pair via httpOnly cookies so the browser can
 * redirect to `/dashboard` already authenticated.
 *
 * The client must replay the exact TOTP secret it received from
 * `/invite/validate`; the server re-validates the token and verifies
 * the 6-digit code against that secret before anything is written.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { DASHBOARD_ACCESS_COOKIE, DASHBOARD_REFRESH_COOKIE } from '@/lib/auth/cookie-names';
import { adminUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { handleAcceptFirmInvite } from '@/server/handlers';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { parseBody } from '@/server/middleware/parse';
import {
  insertDashboardSession,
  revokeAllDashboardSessions,
} from '@/server/repositories';

import { newPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(10).max(256),
  password: newPasswordSchema,
  // Base32 TOTP secret returned from /validate, we accept it as
  // client state rather than persisting a half-enrolled secret. Max
  // length matches the existing TOTP setup contract.
  totpSecret: z.string().min(16).max(128),
  totpCode: totpCodeSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const body = await parseBody(request, Body);
    const now = new Date();
    const authConfig = getAuthConfig();

    const result = await handleAcceptFirmInvite(
      {
        db,
        authConfig,
        now,
        insertSession: insertDashboardSession,
        revokeAllUserSessions: revokeAllDashboardSessions,
      },
      {
        token: body.token,
        password: body.password,
        totpSecret: body.totpSecret,
        totpCode: body.totpCode,
      },
    );

    // Audit, the acceptor is the firm user themselves, but the
    // `actor` pattern expects an identity source; we fall back to a
    // "self" actor using the firm user row so the trail has a subject.
    await writeAudit(db, {
      action: 'firm.user_accepted',
      actor: adminUserActor({ id: result.user.id, label: result.user.email }),
      target: uuidTarget({ kind: 'firm_user', id: result.user.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        firmId: result.user.firmId,
        role: result.user.role,
      },
      ts: now,
    });

    // Recovery-code batch is emitted as a separate audit entry so
    // "when did this user first get their backup codes?" can be
    // reconstructed without grepping through accept events.
    await writeAudit(db, {
      action: 'firm_user.recovery_codes_generated',
      actor: adminUserActor({ id: result.user.id, label: result.user.email }),
      target: uuidTarget({ kind: 'firm_user', id: result.user.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        firmId: result.user.firmId,
        count: result.recoveryCodes.length,
        context: 'invite_accept',
      },
      ts: now,
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json(
      {
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
        recoveryCodes: result.recoveryCodes,
      },
      {
        status: 200,
        headers: {
          'x-request-id': ctx.requestId,
          'cache-control': 'no-store',
        },
      },
    );

    response.cookies.set(DASHBOARD_ACCESS_COOKIE, result.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: authConfig.jwtAccessTtlSeconds,
    });

    response.cookies.set(DASHBOARD_REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/internal/auth/refresh',
      maxAge: authConfig.jwtRefreshTtlSeconds,
    });

    return response;
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
