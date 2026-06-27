/**
 * GET /api/usage — server-side proxy for /api/v1/usage.
 *
 * Same rationale as the session proxy: the API key stays server-side,
 * the browser only sees the relayed body + rate-limit headers.
 */

import { NextResponse } from 'next/server';

import { loadTestFirmConfig } from '../../config';

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

export async function GET(): Promise<NextResponse> {
  const cfg = loadTestFirmConfig();

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.apiBaseUrl}/api/v1/usage`, {
      headers: {
        accept: 'application/json',
        'x-api-key': cfg.apiKey,
      },
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
