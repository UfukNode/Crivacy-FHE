/**
 * Pre-paint theme init script — runs synchronously in `<head>` BEFORE
 * the first paint to eliminate flash-of-wrong-theme (FOWT). Reads
 * `localStorage['crivacy-theme']` ('light' / 'dark' / 'system') with
 * a `prefers-color-scheme` matchMedia fallback when the stored value
 * is missing or 'system'. Wrapped in try/catch so a privacy-mode
 * browser that throws on `localStorage` falls back to dark instead
 * of breaking hydration. Stripe / Vercel / Linear pattern.
 *
 * **Single source of truth.** Both `app/layout.tsx` (renders the
 * `<script>` element) and `middleware.ts::buildCsp` (whitelists the
 * script's SHA-256 in `script-src`) read this literal. The hash is
 * computed once per process boot and is therefore deterministic for
 * the script content baked into the bundle — no manual sync, no
 * "hash drift" if the literal is ever edited.
 *
 * **Why hash-not-nonce.** Next.js 15.5's `runtime: 'nodejs'`
 * middleware (Cat 37b kill-switch needs runtime `process.env`)
 * sets request-header mutations that propagate into Next's
 * internal CSP-nonce-stamping pipeline (so framework bootstrap
 * scripts get the nonce) but *not* into `next/headers::headers()`
 * inside route handlers. The layout would render
 * `<script nonce={undefined}>` → CSP block → no theme attr →
 * dark-only mode. A static SHA-256 hash sidesteps that
 * propagation gap entirely: the script content is baked into the
 * server bundle, so the hash is known at boot, no per-request
 * coupling between middleware and layout.
 *
 * @module
 */

import { createHash } from 'node:crypto';

export const THEME_INIT_SCRIPT = `(function() {
  try {
    var stored = localStorage.getItem('crivacy-theme');
    var theme = stored;
    if (!theme || theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();`;

/**
 * CSP `script-src` source value for the theme init script — the
 * exact form browsers expect: `'sha256-<base64>'` (with single
 * quotes inside the directive). Computed once per process at module
 * load.
 */
export const THEME_INIT_SCRIPT_CSP_HASH: string = (() => {
  const base64 = createHash('sha256').update(THEME_INIT_SCRIPT, 'utf8').digest('base64');
  return `'sha256-${base64}'`;
})();
