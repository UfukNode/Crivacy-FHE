/**
 * GET /api/customer/kyc/events
 *
 * Server-Sent Events endpoint for real-time KYC status updates. The stream
 * sends initial state, periodic heartbeats, and status change events as the
 * customer's KYC sessions progress.
 *
 * NOTE: SSE returns a raw `Response` (not `NextResponse`) because the body
 * is a `ReadableStream`. The `customerRoute` middleware expects `NextResponse`,
 * so this route manually performs auth verification and then delegates to the
 * SSE handler.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthConfig } from '@/lib/auth/config';
import type { VerifiedAccessToken } from '@/lib/auth/jwt';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { getDatabaseClient } from '@/lib/db/client';
import {
  buildCustomerContext,
  buildRequestContext,
} from '@/server/context';
import type { ResolvedCustomer } from '@/server/context';
import { extractCustomerToken } from '@/server/middleware/customer-route';
import { handleKycEvents } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Route handler, manually authenticates, then delegates to SSE handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<Response> {
  const db = getDatabaseClient().db;
  const baseCtx = buildRequestContext(request, db);

  // --- 1. Extract JWT ---
  const token = extractCustomerToken(request);
  if (token === null) {
    return NextResponse.json(
      { error: { code: 'invalid_session', message: 'Authentication required.', requestId: baseCtx.requestId } },
      { status: 401, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  // --- 2. Verify JWT ---
  let resolvedAuthConfig: ReturnType<typeof getAuthConfig>;
  try {
    resolvedAuthConfig = getAuthConfig();
  } catch {
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Auth config not available.', requestId: baseCtx.requestId } },
      { status: 500, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  let verified: VerifiedAccessToken;
  try {
    verified = await verifyAccessToken(token, resolvedAuthConfig, baseCtx.now);
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_session', message: 'Invalid or expired session.', requestId: baseCtx.requestId } },
      { status: 401, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  if (verified.kind !== 'customer') {
    return NextResponse.json(
      { error: { code: 'invalid_session', message: 'This endpoint requires a customer session.', requestId: baseCtx.requestId } },
      { status: 401, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  // --- 3. Look up session ---
  const session = await lookupCustomerSession(db, verified.jti);
  if (session === null || session.revokedAt !== null) {
    return NextResponse.json(
      { error: { code: 'invalid_session', message: 'Session not found or revoked.', requestId: baseCtx.requestId } },
      { status: 401, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  // --- 4. Look up customer ---
  const customer = await lookupCustomer(db, verified.sub);
  if (customer === null || customer.deletedAt !== null) {
    return NextResponse.json(
      { error: { code: 'invalid_session', message: 'Account not found.', requestId: baseCtx.requestId } },
      { status: 401, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  if (customer.status === 'banned' || customer.status === 'suspended') {
    // AUD-X-ERROR-001: reversible suspend vs terminal ban.
    const code = customer.status === 'suspended' ? 'account_suspended' : 'account_banned';
    const message = customer.status === 'suspended'
      ? 'Account is suspended. Contact support to review the restriction.'
      : 'Account has been banned. Please contact support.';
    return NextResponse.json(
      { error: { code, message, requestId: baseCtx.requestId } },
      { status: 403, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  if (customer.status === 'locked') {
    return NextResponse.json(
      { error: { code: 'account_locked', message: 'Account is temporarily locked.', requestId: baseCtx.requestId } },
      { status: 423, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  if (customer.status === 'pending_verification') {
    return NextResponse.json(
      { error: { code: 'email_not_verified', message: 'Please verify your email first.', requestId: baseCtx.requestId } },
      { status: 403, headers: { 'x-request-id': baseCtx.requestId, 'cache-control': 'no-store' } },
    );
  }

  // --- 5. Build CustomerContext ---
  const resolvedCustomer: ResolvedCustomer = {
    id: customer.id,
    email: customer.email,
    displayName: customer.displayName,
    status: customer.status,
    kycLevel: customer.kycLevel,
    kycScore: customer.kycScore,
    revokedAt: customer.revokedAt,
    consecutiveKycDeclines: customer.consecutiveKycDeclines,
    lastDeclineAt: customer.lastDeclineAt,
  };

  const ctx = buildCustomerContext(baseCtx, resolvedCustomer, {
    sessionId: session.id,
    jti: verified.jti,
    kind: 'customer',
  });

  // --- 6. Delegate to SSE handler ---
  return handleKycEvents(ctx);
}
