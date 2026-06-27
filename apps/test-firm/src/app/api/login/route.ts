/**
 * POST /api/login — authenticate an existing TestFirm user.
 *
 * The sibling `/login/page.tsx` renders the form and posts
 * here. Route handler lives under `/api/` so the page and handler
 * don't collide on the same app-router segment.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { applySessionCookie } from '../../session';
import { loginUser } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve the public origin of the incoming request from its Host
 * header, falling back to `request.url` only when the header is
 * missing. Next dev binds on the loopback even when the user is
 * connecting via a LAN IP, so `request.url` returns
 * `http://localhost:3001/...`. Cross-origin redirects (LAN IP →
 * loopback) trip `form-action`/`Location` CSP checks, so every
 * redirect this route hands back must echo the actual host the
 * browser is on.
 */
function publicBase(request: NextRequest): string {
  const host = request.headers.get('host');
  if (host !== null && host.length > 0) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'http';
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

function redirectWithError(request: NextRequest, code: string): NextResponse {
  const url = new URL('/login', publicBase(request));
  url.searchParams.set('error', code);
  return NextResponse.redirect(url, { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const email = form.get('email');
  const password = form.get('password');

  if (typeof email !== 'string' || typeof password !== 'string') {
    return redirectWithError(request, 'bad_payload');
  }

  const outcome = await loginUser(email, password);

  if (outcome.status === 'invalid_credentials') {
    return redirectWithError(request, 'invalid_credentials');
  }

  const res = NextResponse.redirect(
    new URL('/dashboard', publicBase(request)),
    { status: 303 },
  );
  applySessionCookie(res, outcome.token);
  return res;
}
