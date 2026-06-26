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
  // `@node-rs/argon2` is a native addon used to hash the harness's own local
  // user passwords; it cannot be bundled by webpack — require() it at runtime.
  serverExternalPackages: ['@node-rs/argon2'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  typedRoutes: true,
};

export default nextConfig;
