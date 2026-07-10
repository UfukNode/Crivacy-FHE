// @ts-check

/**
 * Standalone output is opt-in via `NEXT_OUTPUT=standalone` (parity with the
 * main Crivacy app). Local dev leaves it unset because the standalone tracer
 * relies on symlinks that need elevated privileges on Windows.
 */
const standaloneMode = process.env['NEXT_OUTPUT'] === 'standalone' ? 'standalone' : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  ...(standaloneMode ? { output: standaloneMode } : {}),
  // `@crivacy-fhe/credential` ships raw TS (main: ./src/index.ts) — run it
  // through this app's TS pipeline so the firm-side FHE decrypt helper compiles.
  transpilePackages: ['@crivacy-fhe/credential'],
  // `@node-rs/argon2` is a native addon (password hashing). `@zama-fhe/sdk`
  // uses a Node worker pool + tfhe WASM for relayer decrypt that webpack /
  // Turbopack mangle when bundled (the relayer's GENERATE_KEYPAIR call hangs).
  // Requiring both at runtime keeps the firm eligibility decrypt working inside
  // the Next route, exactly as it does in a plain node script.
  serverExternalPackages: ['@node-rs/argon2', '@zama-fhe/sdk'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  typedRoutes: true,
};

export default nextConfig;
