/**
 * Test-FHE-Dapp root layout. This is a STANDALONE Next.js app — a mock
 * relying firm that consumes the Crivacy verification gateway over the
 * network (OAuth + REST) exactly like a real third-party integrator.
 *
 * Warm dark palette modeled after the Claude / Anthropic editorial
 * aesthetic. Stone surfaces, restrained orange accent (brand mark +
 * primary CTAs only), serif display headings, hairline borders.
 *
 * The Crivacy embed assets (`button.css` + `crivacy.js`) are served from
 * the Crivacy origin, not this one — loaded cross-origin from
 * `CRIVACY_API_BASE_URL` so the "Verify with Crivacy" button renders the
 * same way it would on any firm's site.
 */

import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Script from 'next/script';

import { loadTestFirmConfig } from './config';
import { TF_SESSION_COOKIE } from './session';
import { findUserBySession } from './user-store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Northwind Finance · Verify with Crivacy',
  description: 'A demo relying firm verifying customer identity through the Crivacy gateway.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = loadTestFirmConfig();

  // Session-aware top-right menu (like a normal app's account area).
  const cookieStore = await cookies();
  const sessionUser = findUserBySession(cookieStore.get(TF_SESSION_COOKIE)?.value ?? null);

  return (
    <html lang="en" data-theme="dark" style={{ colorScheme: 'dark' }}>
      <body className="tcd-shell min-h-screen bg-[#1c1b18] text-stone-100 antialiased">
      <link rel="stylesheet" href={`${cfg.apiBaseUrl}/assets/crivacy/v1/button.css`} />
      <Script src={`${cfg.apiBaseUrl}/assets/crivacy/v1/crivacy.js`} strategy="afterInteractive" />

      <header className="sticky top-0 z-30 border-b border-stone-800/60 bg-[#1c1b18]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <a
              href="/"
              className="flex items-center gap-3 text-stone-100 transition-opacity hover:opacity-90"
              aria-label="Northwind Finance home"
            >
              <span aria-hidden className="relative inline-flex h-9 w-9 items-center justify-center">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 36 36"
                  fill="none"
                  className="overflow-visible"
                >
                  <defs>
                    <radialGradient id="tcd-glow" cx="50%" cy="55%" r="55%">
                      <stop offset="0%" stopColor="#cc785c" stopOpacity="0.55" />
                      <stop offset="55%" stopColor="#cc785c" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="#cc785c" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id="tcd-letter" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#fafaf9" />
                      <stop offset="100%" stopColor="#d6d3d1" />
                    </linearGradient>
                  </defs>

                  {/* Outer rounded square */}
                  <rect
                    x="1"
                    y="1"
                    width="34"
                    height="34"
                    rx="9"
                    fill="#15140f"
                    stroke="rgba(204,120,92,0.5)"
                    strokeWidth="1"
                  />

                  {/* Breathing radial glow behind the letterform */}
                  <circle cx="18" cy="19" r="10" fill="url(#tcd-glow)">
                    <animate
                      attributeName="r"
                      values="8.5;11.5;8.5"
                      dur="2.6s"
                      repeatCount="indefinite"
                      calcMode="spline"
                      keySplines="0.4 0 0.2 1;0.4 0 0.2 1"
                      keyTimes="0;0.5;1"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.55;1;0.55"
                      dur="2.6s"
                      repeatCount="indefinite"
                      calcMode="spline"
                      keySplines="0.4 0 0.2 1;0.4 0 0.2 1"
                      keyTimes="0;0.5;1"
                    />
                  </circle>

                  {/* Bold geometric T (single path) */}
                  <path
                    d="M 7 9 H 29 V 13 H 19.5 V 27 H 16.5 V 13 H 7 Z"
                    fill="url(#tcd-letter)"
                  />

                  {/* Animated cursor dot tracing the bottom of the T stem */}
                  <circle cx="18" cy="29" r="0.9" fill="#cc785c">
                    <animate
                      attributeName="cx"
                      values="16.5;19.5;16.5"
                      dur="2.6s"
                      repeatCount="indefinite"
                      calcMode="spline"
                      keySplines="0.4 0 0.2 1;0.4 0 0.2 1"
                      keyTimes="0;0.5;1"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.4;1;0.4"
                      dur="2.6s"
                      repeatCount="indefinite"
                    />
                  </circle>
                </svg>
              </span>
              <span className="flex flex-col leading-none">
                <span className="font-serif text-[16px] font-medium tracking-tight text-stone-50">
                  Northwind Finance
                </span>
                <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                  Firm using Crivacy
                </span>
              </span>
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-emerald-900/60 bg-emerald-950/30 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-300 sm:inline-flex">
              <span aria-hidden className="relative flex h-2 w-2 items-center justify-center">
                <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
              </span>
              Sepolia
            </span>

            {sessionUser !== null ? (
              <div className="flex items-center gap-2.5">
                <div className="hidden flex-col items-end leading-tight sm:flex">
                  <span className="text-[12px] font-medium text-stone-200">
                    {sessionUser.displayName || sessionUser.email}
                  </span>
                  <span className="font-mono text-[10px] text-stone-500">{sessionUser.email}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element -- external avatar, no next/image domain config in this demo app */}
                <img
                  src={`https://i.pravatar.cc/64?u=${encodeURIComponent(sessionUser.email)}`}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-stone-700"
                />
                <a
                  href="/dashboard"
                  className="inline-flex items-center rounded-md bg-[#cc785c] px-3 py-1.5 text-[12.5px] font-medium text-stone-50 transition-colors hover:bg-[#d4886e]"
                >
                  Open app
                </a>
                <form action="/api/logout" method="POST">
                  <button
                    type="submit"
                    className="inline-flex items-center rounded-md border border-stone-700 bg-stone-900/60 px-3 py-1.5 text-[12.5px] font-medium text-stone-300 transition-colors hover:border-stone-600 hover:bg-stone-900 hover:text-stone-100"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : (
              <a
                href="/login"
                className="inline-flex items-center rounded-md border border-stone-700 bg-stone-900/60 px-3.5 py-1.5 text-[12.5px] font-medium text-stone-200 transition-colors hover:border-stone-600 hover:bg-stone-900"
              >
                Sign in
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 sm:py-8">{children}</main>

      <footer className="border-t border-stone-800/60">
        <div className="mx-auto max-w-7xl px-6 py-6 text-[12px] text-stone-500">
          Northwind Finance. A demo firm verifying customer identity through Crivacy on Sepolia.
        </div>
      </footer>
      </body>
    </html>
  );
}
