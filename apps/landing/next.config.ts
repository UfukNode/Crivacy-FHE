import type { NextConfig } from "next";

// Next.js, for prerendered static pages, emits
//   Cache-Control: s-maxage=31536000
// which tells Cloudflare to cache the HTML for a full year. The HTML
// references content-hashed JS chunks; after a redeploy, the old chunk
// names disappear and any cached HTML still pointing at them produces
// a "This page couldn't load" error in the browser.
//
// The headers() override below restricts HTML cache to a 60s shared TTL
// (with up to 10 minutes of stale-while-revalidate) and forces browsers
// to revalidate on every request. Static chunks under /_next/static are
// content-hashed and safe to cache aggressively, so we keep the long
// immutable cache there.
// Next already emits `public, max-age=31536000, immutable` for files under
// /_next/static, so we don't touch those. We only override the HTML pages.
const htmlCache =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=600, must-revalidate";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: htmlCache }],
      },
      {
        source: "/sdk",
        headers: [{ key: "Cache-Control", value: htmlCache }],
      },
      {
        source: "/waitlist-confirmed",
        headers: [{ key: "Cache-Control", value: htmlCache }],
      },
    ];
  },
  // The /tech page was renamed to /sdk. Permanent redirect keeps any
  // external link (footer, docs, social posts) working.
  async redirects() {
    return [
      { source: "/tech", destination: "/sdk", permanent: true },
    ];
  },
};

export default nextConfig;
