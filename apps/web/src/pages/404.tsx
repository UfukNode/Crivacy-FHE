/**
 * Pages-Router `/404` override.
 *
 * App Router's `app/not-found.tsx` is the "real" 404 surface — every
 * not-found render at runtime hits that. This file exists only to
 * stop Next.js's BUILD step from synthesising a default Pages Router
 * 404 from the legacy `_error` template, which in 15.5.x renders
 * `<Html>` outside the `_document` context and crashes the build with
 * "Html should not be imported outside of pages/_document".
 *
 * By providing an explicit `pages/404.tsx`, Next.js stops synthesising
 * the fallback and uses this file instead. The component is a tiny
 * static return — no Html, no _document context required, no
 * client-side data — so the static prerender succeeds.
 *
 * Note: at runtime, App Router's `app/not-found.tsx` takes precedence
 * for any path the router actually serves, so this file is effectively
 * a build-time appeasement, not a user-facing artefact.
 */
export default function Custom404() {
  return null;
}
