import type { Metadata, Viewport } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import { SkipNav } from '@/components/shared/skip-nav';
import { Providers } from '@/components/shared/providers';
import { CookieConsent } from '@/components/shared/cookie-consent';
import { getAppUrl } from '@/lib/env/app-url';
import { THEME_INIT_SCRIPT } from '@/lib/security/theme-init-script';
import './globals.css';

/**
 * Force every page under this root to be dynamically rendered. The
 * middleware (`apps/web/src/middleware.ts::buildCsp`) mints a fresh
 * CSP nonce per request and writes it onto the request headers. Next
 * 13.4+ stamps the nonce onto its inline bootstrap scripts ONLY when
 * the page reads `headers()` at render time, which a statically
 * pre-rendered page cannot do, the nonce does not exist at build
 * time. Without `force-dynamic` the static auth shell ships with no
 * nonce attribute on its inline scripts, the browser sees the
 * `'nonce-XXX' 'strict-dynamic'` CSP, blocks the bootstrap, and
 * React hydration never runs. The whole reason `'unsafe-inline'`
 * lived in the legacy CSP was to paper over exactly this, flipping
 * to nonce-based CSP requires every page to be SSR.
 *
 * Cost: public surfaces (`/terms`, `/privacy`, `/status`, `/docs/*`)
 * are now SSR per request rather than served from the build cache.
 * Volume there is small relative to authed traffic and CDN-level
 * caching (Cache-Control: public, s-maxage=...) can rehydrate the
 * static perf characteristics if it becomes a hot spot. Worth the
 * trade for collapsing the script-XSS attack surface across every
 * audience (PROD-TODO #6).
 *
 * Child route segments inherit this default; a future page can opt
 * back into static if a specific surface justifies it (e.g. the
 * status RSS feed) and the CSP path can tolerate the lost nonce.
 */
export const dynamic = 'force-dynamic';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Crivacy · FHE-powered re-usable KYC',
    template: '%s · Crivacy',
  },
  description:
    'Crivacy is a FHE-powered re-usable KYC credential platform for B2B integrations. Verify once, use everywhere.',
  applicationName: 'Crivacy',
  authors: [{ name: 'Crivacy' }],
  keywords: ['KYC', 'FHE', 'Zama', 'credentials', 'identity', 'on-chain', 'B2B', 'compliance', 'Didit'],
  creator: 'Crivacy',
  publisher: 'Crivacy',
  metadataBase: new URL(getAppUrl()),
  openGraph: {
    title: 'Crivacy',
    description: 'FHE-powered re-usable KYC credentials. Verify once, use everywhere, on-chain.',
    url: 'https://crivacy.io',
    siteName: 'Crivacy',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crivacy',
    description: 'FHE-powered re-usable KYC credentials. Verify once, use everywhere, on-chain.',
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
  colorScheme: 'dark light',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable}`}>
      <head>
        {/* Pre-paint theme init, whitelisted in CSP via SHA-256 hash
         * (`middleware.ts::buildCsp` reads `THEME_INIT_SCRIPT_CSP_HASH`).
         * Hash-based whitelist instead of nonce because Next 15.5
         * `runtime: 'nodejs'` middleware doesn't propagate
         * `request.headers.set('x-nonce', ...)` into route-handler
         * `headers()`, a layout-side `nonce` attribute would render
         * empty and the script would be blocked. Static literal +
         * static hash is robust across that propagation gap. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
          <SkipNav />
          <Providers>{children}</Providers>
          <CookieConsent />
        </body>
    </html>
  );
}
