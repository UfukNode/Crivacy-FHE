/**
 * POST /api/session — server-side proxy for /api/v1/sessions.
 *
 * The browser never learns the firm's API key. The client passes only
 * the session-creation payload; this route:
 *
 *   1. Forwards it to Crivacy with `x-api-key` attached.
 *   2. Persists the resulting session to TestFirm's data store so
 *      the dashboard can list "my active KYC sessions" later and
 *      incoming webhooks can update their status.
 *   3. Relays the body + rate-limit headers back to the browser
 *      verbatim so a developer sees exactly what a real integration
 *      would observe.
 *
 * Guarded by the TestFirm session cookie — anonymous visitors
 * cannot create KYC sessions that would be billed to this firm.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { loadTestFirmConfig } from '../../config';
import { recordKycSession } from '../../data-store';
import { TF_SESSION_COOKIE } from '../../session';
import { findUserBySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORWARDED_HEADER_PREFIXES = [
  'x-ratelimit-',
  'x-quota-',
  'retry-after',
  'x-request-id',
];

function shouldForward(headerName: string): boolean {
  const lower = headerName.toLowerCase();
  return FORWARDED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

interface SessionCreatePayload {
  readonly userRef?: unknown;
  readonly workflow?: unknown;
  readonly level?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cfg = loadTestFirmConfig();

  // Require a valid TestFirm session so anonymous callers can't mint
  // sessions against the firm's key.
  const tfToken = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  const tfUser = findUserBySession(tfToken);
  if (tfUser === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Parse the client-supplied payload up-front so we can stamp the
  // persisted record even if the upstream response body is opaque.
  const rawBody = await request.text();
  let parsedBody: SessionCreatePayload = {};
  try {
    parsedBody = JSON.parse(rawBody) as SessionCreatePayload;
  } catch {
    // Invalid JSON — pass through to Crivacy anyway; it will 400.
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.apiBaseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': cfg.apiKey,
      },
      body: rawBody,
      cache: 'no-store',
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'upstream_network_error',
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }

  const responseBody = await upstream.text();

  // On a 2xx response, write a row to the store. A real firm keeps
  // this pending session tied to its own user so it can reconcile
  // the later webhook into a completed KYC.
  if (upstream.status >= 200 && upstream.status < 300) {
    try {
      const parsed = JSON.parse(responseBody) as {
        id?: unknown;
        verification_url?: unknown;
        status?: unknown;
      };
      const id = typeof parsed.id === 'string' ? parsed.id : null;
      if (id !== null) {
        recordKycSession({
          id,
          firmUserId: tfUser.id,
          userRef: typeof parsedBody.userRef === 'string' ? parsedBody.userRef : tfUser.id,
          workflow: typeof parsedBody.workflow === 'string' ? parsedBody.workflow : 'unknown',
          level: typeof parsedBody.level === 'string' ? parsedBody.level : 'unknown',
          verificationUrl:
            typeof parsed.verification_url === 'string' ? parsed.verification_url : null,
          status: typeof parsed.status === 'string' ? parsed.status : 'created',
          createSnapshot: parsed,
        });
      }
    } catch {
      // If the body isn't JSON (e.g. plaintext error in a weird edge
      // case), skip the persistence step — the response still relays.
    }
  }

  const res = new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
  upstream.headers.forEach((value, key) => {
    if (shouldForward(key)) {
      res.headers.set(key, value);
    }
  });
  return res;
}
