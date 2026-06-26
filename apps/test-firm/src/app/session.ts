/**
 * TestFirm session cookie helper — single source of truth for the
 * cookie name + attributes so the register/login/logout paths
 * agree on every detail (TTL, scope, SameSite). httpOnly is
 * mandatory so TestFirm's client JS can never read the token.
 *
 * Scoped to `/` so Crivacy's own cookies at other paths
 * aren't trampled.
 */

import 'server-only';

import type { NextResponse } from 'next/server';

export const TF_SESSION_COOKIE = 'tf_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export function applySessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(TF_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.delete(TF_SESSION_COOKIE);
}
