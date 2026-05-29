/**
 * Docs index page (`/docs`), the marketing surface a firm lands
 * on from the public site. Owns the first-impression load for the
 * whole developer experience, so it leans heavier on layout and
 * illustration than the inner reference pages:
 *
 *   1. Hero with H1 + two CTAs (Get started, API reference) next
 *      to a static, readable `curl` preview of the simplest
 *      integration, mirrors the Stripe / Supabase home pattern.
 *   2. Feature strip (5 bullets) summarising the product value
 *      props that matter to an integrator evaluating us.
 *   3. Category cards grid, what DOC_CATEGORIES carries, but
 *      the visual weight tuned up (hover elevation, accent
 *      border, item count per category).
 *   4. Popular guides list grouped by category so the reader
 *      can fan out into a real reading path instead of a flat
 *      grid.
 *
 * Everything is server-rendered, no client state or data
 * fetching. Colours come from the shared `--color-*` tokens so
 * the same markup renders correctly in both light and dark
 * themes when the toggle flips.
 *
 * @module
 */

import type { Metadata } from 'next';

import Link from 'next/link';

import { DOCS_NAV, DOC_CATEGORIES, getDocsByCategory } from '@/lib/docs';

import type { DocCategory } from '@/lib/docs';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'Crivacy developer documentation. Integrate re-usable KYC credentials anchored on Sepolia with the Verify-with-Crivacy OAuth flow.',
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const CATEGORY_ICONS: Record<DocCategory, string> = {
  overview:
    'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  guides:
    'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
  'api-reference':
    'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5',
  resources:
    'M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
};

const FEATURE_STRIP: ReadonlyArray<{
  readonly title: string;
  readonly description: string;
  readonly path: string;
}> = [
  {
    title: 'FHE-powered',
    description: 'Every credential is anchored on Sepolia for tamper evidence.',
    path: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    title: 'Verify once, reuse everywhere',
    description: 'The user runs KYC with Crivacy a single time and every partner firm can reuse it.',
    path: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
  },
  {
    title: 'Standard OAuth 2.0 + OIDC',
    description: 'Authorization-code + PKCE. Works with any openid-client, authlib, or NextAuth setup.',
    path: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  },
  {
    title: 'Privacy-preserving claims',
    description: "Firms receive verification flags + a proof hash, never the user's raw PII.",
    path: 'M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z',
  },
  {
    title: 'Real-time webhooks',
    description: '11 signed event types so your back-office updates the moment a credential changes.',
    path: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  },
];

// A hand-picked highlight per category so the "popular guides"
// section doesn't just dump DOCS_NAV verbatim. Keeps the surface
// curated rather than exhaustive.
const POPULAR_SLUGS = [
  'getting-started',
  'oauth',
  'authentication',
  'credentials',
  'webhooks',
  'api-reference',
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DocsIndexPage() {
  const categories = (Object.keys(DOC_CATEGORIES) as DocCategory[]).sort(
    (a, b) => DOC_CATEGORIES[a].order - DOC_CATEGORIES[b].order,
  );

  const popular = POPULAR_SLUGS.map((slug) => DOCS_NAV.find((item) => item.slug === slug)).filter(
    (item): item is (typeof DOCS_NAV)[number] => item !== undefined,
  );

  return (
    <main className="flex-1 py-10 lg:py-14">
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="relative mb-16 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* Subtle gradient, drawn in CSS so it recolors with the
            theme toggle without any JS. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-80"
          style={{
            background:
              'radial-gradient(800px 400px at 10% 0%, color-mix(in srgb, var(--color-accent) 15%, transparent), transparent 60%), radial-gradient(600px 300px at 90% 100%, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 65%)',
          }}
        />

        <div className="relative grid gap-10 px-6 py-12 sm:px-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:px-12 lg:py-16">
          {/* Left, copy + CTAs */}
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-3 py-1 text-xs font-medium text-[var(--color-accent)]">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]"
              />
              Crivacy developer docs
            </p>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-[var(--color-fg)] sm:text-5xl">
              FHE-powered KYC credentials, wired into your app in minutes.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-[var(--color-fg)] opacity-85">
              Add a <strong className="font-semibold">Verify with Crivacy</strong> button to your
              site. Users verify their identity once on our consent flow; every participating firm
              receives a signed, tamper-evident credential, no PII leaves Crivacy's boundary.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/getting-started"
                className="inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-[var(--shadow-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-accent-hover)]"
              >
                Get started
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
              <Link
                href="/docs/api-reference"
                className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--color-fg)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-muted)]"
              >
                Read the API reference
              </Link>
            </div>
          </div>

          {/* Right, static cURL preview so the hero carries a
              concrete "this is what you paste" moment rather
              than just marketing copy. */}
          <div className="relative">
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[#0b0d10] shadow-[var(--shadow-md)]">
              <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" aria-hidden="true" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" aria-hidden="true" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" aria-hidden="true" />
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">
                  TERMINAL
                </span>
              </div>
              <pre className="overflow-x-auto px-4 py-4 font-mono text-xs leading-relaxed text-gray-300">
                <code>
                  <span className="text-emerald-400">$</span>{' '}
                  <span className="text-gray-100">curl</span>{' '}
                  <span className="text-amber-300">-X POST</span>{' '}
                  <span className="text-gray-400">https://app.crivacy.io/api/v1/oauth/token</span>{' '}
                  <span className="text-amber-300">\</span>
                  {'\n'}
                  {'    '}
                  <span className="text-amber-300">-H</span>{' '}
                  <span className="text-green-300">
                    {'"'}Content-Type: application/x-www-form-urlencoded{'"'}
                  </span>{' '}
                  <span className="text-amber-300">\</span>
                  {'\n'}
                  {'    '}
                  <span className="text-amber-300">-d</span>{' '}
                  <span className="text-green-300">
                    {'"'}grant_type=authorization_code&code=...{'"'}
                    {'\n'}
                  </span>
                  {'\n'}
                  {'{'}
                  {'\n  '}
                  <span className="text-sky-300">{'"'}access_token{'"'}</span>:{' '}
                  <span className="text-green-300">{'"'}tok_…{'"'}</span>,{'\n  '}
                  <span className="text-sky-300">{'"'}id_token{'"'}</span>:{' '}
                  <span className="text-green-300">{'"'}eyJhbGciOiJIUzI1Ni…{'"'}</span>,{'\n  '}
                  <span className="text-sky-300">{'"'}token_type{'"'}</span>:{' '}
                  <span className="text-green-300">{'"'}Bearer{'"'}</span>,{'\n  '}
                  <span className="text-sky-300">{'"'}expires_in{'"'}</span>:{' '}
                  <span className="text-orange-300">3600</span>
                  {'\n}'}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Feature strip                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-16">
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURE_STRIP.map((feat) => (
            <li
              key={feat.title}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={feat.path} />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-[var(--color-fg)]">{feat.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
                {feat.description}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Category cards                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-16">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
              Start here
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Four entry points, each curated for a different stage of integration.
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {categories.map((key) => {
            const meta = DOC_CATEGORIES[key];
            const items = getDocsByCategory(key);
            const firstItem = items[0];
            const href = firstItem !== undefined ? `/docs/${firstItem.slug}` : '/docs';
            const iconPath = CATEGORY_ICONS[key];

            return (
              <Link
                key={key}
                href={href}
                className="group relative flex gap-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-all duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-surface-hover)] hover:shadow-[var(--shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] transition-colors group-hover:bg-[var(--color-accent)]/20">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-accent)]">
                      {meta.label}
                    </h3>
                    <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                      {items.length} {items.length === 1 ? 'page' : 'pages'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
                    {meta.description}
                  </p>
                </div>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4 shrink-0 self-center text-[var(--color-muted)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--color-accent)]"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Popular guides                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <div className="mb-5">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            Popular guides
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            The pages most integrators open first.
          </p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {popular.map((item) => {
            const categoryLabel = DOC_CATEGORIES[item.category].label;
            return (
              <li key={item.slug}>
                <Link
                  href={`/docs/${item.slug}`}
                  className="group flex h-full flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-surface-hover)]"
                >
                  <span className="inline-flex w-fit rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                    {categoryLabel}
                  </span>
                  <h3 className="mt-3 text-sm font-semibold text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-accent)]">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
                    {item.description}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
