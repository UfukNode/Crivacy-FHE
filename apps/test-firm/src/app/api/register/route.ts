/**
 * POST /api/register — create a TestFirm user + open a session.
 *
 * The sibling `/register/page.tsx` renders the form and
 * posts here. Keeping the route handler under `/api/` avoids the
 * Next.js app-router collision where a `page.tsx` + `route.ts` in
 * the same segment shadow each other.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { applySessionCookie } from '../../session';
import { loginUser, registerUser } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectWithError(request: NextRequest, code: string): NextResponse {
  const url = new URL('/register', request.url);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url, { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const email = form.get('email');
  const password = form.get('password');
  const displayName = form.get('displayName');

  if (typeof email !== 'string' || typeof password !== 'string') {
    return redirectWithError(request, 'bad_payload');
  }

  const outcome = await registerUser(
    email,
    password,
    typeof displayName === 'string' ? displayName : null,
  );

  if (outcome.status === 'invalid_email') {
    return redirectWithError(request, 'invalid_email');
  }
  if (outcome.status === 'email_taken') {
    return redirectWithError(request, 'email_taken');
  }
  if (outcome.status === 'weak_password') {
    return redirectWithError(request, 'weak_password');
  }

  // Success: issue a session via the canonical login path so
  // `sessions` stays the single source of truth for token → user.
  const loginOutcome = await loginUser(email, password);
  if (loginOutcome.status !== 'ok') {
    // Shouldn't happen — we just created this user with this password.
    return redirectWithError(request, 'unknown');
  }

  const res = NextResponse.redirect(new URL('/dashboard', request.url), {
    status: 303,
  });
  applySessionCookie(res, loginOutcome.token);
  return res;
}
