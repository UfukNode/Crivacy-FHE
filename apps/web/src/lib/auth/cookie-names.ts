/**
 * Centralized cookie name constants for all three portals.
 *
 * Every file that reads or writes auth cookies MUST import from here.
 * This prevents the desync bugs that occur when the same string
 * is copy-pasted into 10+ files.
 *
 * ## SECURITY NOTE — `domain` attribute intentionally omitted
 *
 * None of the `response.cookies.set(...)` calls in this codebase set
 * a `domain` attribute. That is a DELIBERATE security decision, not
 * an oversight:
 *
 *   - Browser "host-only" default: the cookie is scoped to the exact
 *     host that issued it (e.g. `app.crivacy.io`), NOT sent to
 *     siblings like `dashboard.crivacy.io` or `admin.crivacy.io`.
 *   - This isolates the three portals — a stolen customer access
 *     token cannot reach the firm dashboard API, and vice versa.
 *
 * If a future commit ever sets `domain: '.crivacy.io'` (or any parent
 * domain) on these cookies to "enable SSO across subdomains", that
 * silently breaks the isolation and a single subdomain-takeover
 * incident would leak every audience's session. ANY change that adds
 * a `domain:` attribute requires an explicit security review — open
 * an AUDIT.md finding first, get sign-off, then land the change.
 *
 * AUD-X-COOKIE-002 tracks this constraint as documentation.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Customer portal (app.crivacy.io)
// ---------------------------------------------------------------------------

/** Customer access token — httpOnly, Secure, SameSite=Strict, path=/ */
export const CUSTOMER_ACCESS_COOKIE = '__crivacy_ct';

/** Customer refresh token — httpOnly, Secure, SameSite=Strict, path=/api/customer/auth/refresh */
export const CUSTOMER_REFRESH_COOKIE = '__crivacy_crt';

// ---------------------------------------------------------------------------
// Firm dashboard (dashboard.crivacy.io)
// ---------------------------------------------------------------------------

/** Dashboard access token — httpOnly, Secure, SameSite=Strict, path=/ */
export const DASHBOARD_ACCESS_COOKIE = '__crivacy_at';

/** Dashboard refresh token — httpOnly, Secure, SameSite=Strict, path=/api/internal/auth/refresh */
export const DASHBOARD_REFRESH_COOKIE = '__crivacy_art';

// ---------------------------------------------------------------------------
// Admin panel (admin.crivacy.io)
// ---------------------------------------------------------------------------

/** Admin access token — httpOnly, Secure, SameSite=Strict, path=/ */
export const ADMIN_ACCESS_COOKIE = '__crivacy_admin_at';

/** Admin refresh token — httpOnly, Secure, SameSite=Strict, path=/api/internal/admin/auth/refresh */
export const ADMIN_REFRESH_COOKIE = '__crivacy_admin_rt';

// ---------------------------------------------------------------------------
// Google OAuth (temporary cookies)
// ---------------------------------------------------------------------------

/** OAuth CSRF nonce — httpOnly, Secure, SameSite=Lax, 10 min TTL */
export const OAUTH_NONCE_COOKIE = '__crivacy_oauth_nonce';

/** Google completion token — httpOnly, Secure, SameSite=Strict, 10 min TTL */
export const GOOGLE_COMPLETION_COOKIE = '__crivacy_google_completion';
