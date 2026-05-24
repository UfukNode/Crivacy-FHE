/**
 * POST /api/internal/auth/invite/validate
 *
 * Public endpoint (no auth cookies required), validates a firm-user
 * invitation token sent in the welcome email and returns the data
 * needed to render the acceptance form:
 *   - the recipient's email (read-only on the form, helps prevent
 *     typos when the user was forwarded the wrong link)
 *   - the firm name (surfaced in the page heading)
 *   - a freshly-generated TOTP secret + `otpauth://` URL for the
 *     authenticator app QR code. The secret is NOT persisted server
 *     side until the user proves possession in the /accept call, so
 *     there is no "half-enrolled" database state.
 *
 * Failure cases map to HTTP status per semantics:
 *   - 404 unknown token
 *   - 410 already used / expired
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';
import { handleValidateFirmInvite } from '@/server/handlers';
import { mapErrorToResponse } from '@/server/middleware/error-mapper';
import { parseBody } from '@/server/middleware/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(10).max(256),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);

  try {
    const body = await parseBody(request, Body);
    const result = await handleValidateFirmInvite(
      { db, authConfig: getAuthConfig(), now: new Date() },
      body.token,
    );
    return NextResponse.json(result, {
      status: 200,
      headers: {
        'x-request-id': ctx.requestId,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
  }
}
