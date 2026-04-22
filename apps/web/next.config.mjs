// @ts-check

/**
 * Standalone output is opt-in via `NEXT_OUTPUT=standalone`. CI and the
 * production Docker build set this so Next.js emits the self-contained
 * `.next/standalone` tree the runtime image consumes. Local dev (Windows in
 * particular) leaves it unset because the standalone tracer relies on
 * symlinks that require elevated privileges on Windows; everything still
 * type-checks, lints, tests, and builds in the regular mode.
 */
const standaloneMode = process.env['NEXT_OUTPUT'] === 'standalone' ? 'standalone' : undefined;

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  devIndicators: false,
  ...(standaloneMode ? { output: standaloneMode } : {}),
  // The `@crivacy-fhe/*` packages publish raw TypeScript source (no build
  // step, `main: ./src/index.ts`). Workspace `workspace:*` mode resolves
  // them in-tree today, but once pinned to a registry version the same
  // files arrive as external `node_modules` and Next.js refuses to compile
  // them without an explicit allow-list. The list below runs the
  // @crivacy-fhe family through the application's TS pipeline regardless of
  // where the package is resolved from.
  transpilePackages: [
    '@crivacy-fhe/credential',
    '@crivacy-fhe/adapter-didit',
  ],
  // These packages use Node.js built-ins (stream, cluster, http2, net, fs)
  // that webpack cannot resolve. Tell Next.js to require() them at runtime.
  serverExternalPackages: [
    'pg',
    'pg-pool',
    'pg-connection-string',
    'pg-boss',
    'pgpass',
    'pino',
    'pino-pretty',
    'prom-client',
    'sharp',
    '@node-rs/argon2',
    '@node-rs/bcrypt',
    'nodemailer',
    // jsdom + isomorphic-dompurify must stay outside the bundle:
    // jsdom does a module-load `readFileSync('default-stylesheet.css')`
    // that Turbopack rewrites to a virtual `C:\ROOT\` prefix and fails
    // with ENOENT. Externalised the pair so Next.js `require()`s them
    // at runtime from real `node_modules`.
    'isomorphic-dompurify',
    'jsdom',
    '@opentelemetry/api',
    '@opentelemetry/sdk-node',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-fetch',
    '@opentelemetry/otlp-grpc-exporter-base',
    '@grpc/grpc-js',
  ],
  webpack(config, { isServer, nextRuntime }) {
    if (isServer) {
      if (nextRuntime === 'edge') {
        // Edge Runtime (middleware) cannot use Node.js modules.
        // Next.js internals import @opentelemetry/api in tracer.js —
        // alias it to our no-op shim that provides createContextKey etc.
        config.resolve = config.resolve || {};
        config.resolve.alias = {
          ...(config.resolve.alias || {}),
          '@opentelemetry/api': resolve(__dirname, 'src/lib/otel-edge-shim.js'),
        };
        return config;
      }

      // Node.js server: OTel + gRPC have deep transitive deps on
      // Node.js built-ins. Externalize so webpack skips them.
      const orig = config.externals;
      config.externals = [
        ...(Array.isArray(orig) ? orig : orig ? [orig] : []),
        (/** @type {{ request: string }} */ { request }, /** @type {Function} */ callback) => {
          // Externalize node: built-in scheme (node:crypto, node:fs, etc.)
          if (/^node:/.test(request)) {
            return callback(null, `commonjs ${request}`);
          }
          if (
            /^@opentelemetry\//.test(request) ||
            /^@grpc\//.test(request) ||
            /^@node-rs\//.test(request) ||
            /^pg/.test(request) ||
            request === 'pg-boss' ||
            request === 'pgpass' ||
            request === 'split2' ||
            request === 'pino' ||
            request === 'pino-pretty' ||
            request === 'prom-client' ||
            request === 'sharp' ||
            request === 'nodemailer'
          ) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
  eslint: {
    // Biome handles linting; Next's built-in ESLint is disabled.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Enforced via `pnpm typecheck` in CI, not during next build.
    ignoreBuildErrors: false,
  },
  experimental: {
    typedRoutes: true,
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    // Content-Security-Policy is emitted PER REQUEST by the edge
    // middleware (`apps/web/src/middleware.ts::buildCsp`) so it can
    // mint a fresh nonce for every response and use
    // `'nonce-XXX' 'strict-dynamic'` on `script-src` instead of the
    // legacy `'unsafe-inline'`. That removal closes PROD-TODO #6.
    //
    // The other security headers below (X-Frame-Options, HSTS,
    // Permissions-Policy, COOP, CORP, Origin-Agent-Cluster) are
    // request-invariant and stay in this static config — Next.js
    // applies them to every response without the middleware needing
    // to repeat them. Style-src and the rest of the CSP directives
    // (img-src, frame-src, etc.) live in middleware now too because
    // splitting CSP across two emitters would let the browser see
    // two separate `Content-Security-Policy` headers and intersect
    // them — the more restrictive wins, which is hard to reason
    // about. Keeping CSP in exactly one place is the simpler invariant.

    // Audit-mode override (Adım 5.5 runtime fix-verify): when
    // CRIVACY_AUDIT_LOCAL_HTTP=true, omit HSTS so localhost http origin
    // doesn't get upgrade-locked by the browser (breaks _next/static
    // asset loading via HSTS upgrade-insecure-requests). Real prod still
    // emits HSTS unconditionally.
    const auditLocalHttp = process.env['CRIVACY_AUDIT_LOCAL_HTTP'] === 'true';

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            // AUD-X-HEADERS-001 fix: expand Permissions-Policy to the
            // full modern browser-feature surface. Crivacy does not
            // use any of these APIs — every directive set to `()`
            // (empty allowlist = denied everywhere). `fullscreen` and
            // `publickey-credentials-get` are scoped to `self` so our
            // own origin can still use them (fullscreen for future
            // UX, WebAuthn as a future TOTP successor) while
            // third-party iframes cannot request either. A compromised
            // npm dependency trying to silently fingerprint via
            // sensor / payment / clipboard / idle APIs hits a
            // browser-level deny before it can call the API.
            key: 'Permissions-Policy',
            value: [
              'accelerometer=()',
              'attribution-reporting=()',
              'autoplay=()',
              'bluetooth=()',
              'browsing-topics=()',
              'camera=()',
              'clipboard-read=()',
              'display-capture=()',
              'encrypted-media=()',
              'fullscreen=(self)',
              'geolocation=()',
              'gyroscope=()',
              'hid=()',
              'idle-detection=()',
              'interest-cohort=()',
              'magnetometer=()',
              'microphone=()',
              'midi=()',
              'payment=()',
              'publickey-credentials-get=(self)',
              'screen-wake-lock=()',
              'serial=()',
              'usb=()',
              'xr-spatial-tracking=()',
            ].join(', '),
          },
          ...(auditLocalHttp
            ? []
            : [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]),
          // Content-Security-Policy is emitted per-request by the
          // middleware — see the comment at the top of `headers()`
          // and `apps/web/src/middleware.ts::buildCsp`. Do NOT also
          // emit it here; two CSP headers from one origin are
          // intersected by the browser and the result is hard to
          // reason about.
          // Cross-origin isolation for the browsing context. `same-origin`
          // severs the `window.opener` link on cross-origin navigations
          // so a `target="_blank"` link that forgets `rel="noopener"`
          // can't reach back into the original document — the classic
          // tabnabbing vector. `noopener-allow-popups` would also work
          // but it's less restrictive; we take the stricter option.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // Cross-origin resource isolation. `same-origin` stops other
          // origins from embedding our responses via `<img>`, `<script>`,
          // `fetch`, etc. — belt-and-suspenders against Spectre-class
          // side-channel reads and against third parties rehosting our
          // responses as their own. Does NOT affect APIs served under
          // `/api/v1/*` because those are consumed directly (not cross-
          // site embedded), so the header is harmless for legitimate
          // integrators.
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          // One origin = one agent cluster. Forces browsers to
          // isolate this origin into its own Origin Agent Cluster,
          // which cuts off `document.domain`-style cross-origin
          // document mutation (an ancient same-site vulnerability
          // that still trips many shared-hosting setups).
          { key: 'Origin-Agent-Cluster', value: '?1' },
        ],
      },
      {
        // Invite-acceptance page — tighten the Referer policy so the
        // URL fragment (post-migration) or any residual query-string
        // token can never leak via Referer, even to same-origin
        // navigations that might appear later. Paired with
        // `Cache-Control: no-store` so intermediate proxies never
        // retain the HTML response.
        source: '/dashboard/accept-invite',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        // Public Crivacy SDK assets — firms embed these on their own
        // origins to mount the "Verify with Crivacy" button. The
        // global `Cross-Origin-Resource-Policy: same-origin` above
        // would block those cross-origin embeds; relax it for this
        // path so the integration keeps working while every other
        // resource on our origin stays CORP-locked.
        source: '/assets/crivacy/v1/:path*',
        headers: [
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
