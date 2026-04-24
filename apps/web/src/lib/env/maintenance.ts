/**
 * Platform kill-switch — read-once env gate that short-circuits every
 * non-exempt request with HTTP 503 when set.
 *
 * This is the breach-response toggle of last resort. The hierarchy of
 * incident-response tools looks like:
 *
 *   1. Rate-limit denial (per-IP / per-account) — automatic, fine-grained
 *   2. Per-customer / per-firm ban (admin panel) — surgical
 *   3. JWT_SECRET rotation (see `docs/runbooks/key-rotation.md`)
 *      — invalidates every active session platform-wide
 *   4. **`CRIVACY_MAINTENANCE_MODE=1`** — this module. Flips the whole
 *      non-admin surface to 503 instantly after a redeploy so on-call
 *      can investigate without user traffic continuing to land.
 *
 * Design tradeoffs behind env-over-DB:
 *
 *   * **Speed under breach**: redeploying with a new env takes ~30s.
 *     A DB-backed toggle would be ~1s, but if the DB itself is the
 *     compromised surface, the toggle silently fails. The env var
 *     survives a DB outage; the DB toggle does not. We pick the more
 *     robust worst-case.
 *   * **Fail-loud on misconfig**: a forgotten maintenance flag at
 *     redeploy announces itself as 503 for every customer request on
 *     the next health probe — that's the right failure mode for a
 *     "kill everything" toggle.
 *   * **No new schema**: breach-response shouldn't depend on a
 *     migration that hasn't run yet.
 *
 * Exempt routes (maintenance mode does NOT gate these):
 *
 *   * `/admin/*` — platform operators must be able to act during an
 *     incident. The admin surface has its own session gate; a
 *     compromised admin session is what the kill-switch is trying to
 *     limit in the first place, and losing admin access during the
 *     response would make containment impossible.
 *   * `/api/internal/admin/*` — admin API routes, same rationale.
 *   * `/api/v1/health` — liveness probe for Prometheus / load balancer.
 *   * `/status`, `/api/v1/status` — public status page so customers
 *     see an explanation instead of a raw 503.
 *   * `/_next/*`, `/assets/*`, `/favicon*` — static assets; the 503
 *     HTML rendered by the exempt paths needs to load.
 *
 * See `docs/runbooks/maintenance-mode.md` for activation procedure
 * and the forced-logout tradeoff documentation.
 *
 * @module
 */

/**
 * Environment variable names accepted as "enabled" truthy values.
 * `'1'`, `'true'`, `'yes'`, `'on'` all flip the switch; anything else
 * (including absence) leaves it off. Case-insensitive.
 */
const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

let cachedValue: boolean | undefined;

/**
 * Read `CRIVACY_MAINTENANCE_MODE` once per process. Memoized: a
 * runtime env change does not flip the switch until the next
 * process restart. That's intentional — kill-switch has to be
 * activated via a conscious redeploy, not by a compromised
 * subprocess flipping an env var mid-flight.
 */
export function isMaintenanceMode(): boolean {
  if (cachedValue !== undefined) return cachedValue;
  const raw = process.env['CRIVACY_MAINTENANCE_MODE']?.trim().toLowerCase();
  cachedValue = raw !== undefined && TRUTHY_VALUES.has(raw);
  return cachedValue;
}

/** Test-only helper — drop the memoised env read so per-case overrides apply. */
export function resetMaintenanceModeForTests(): void {
  cachedValue = undefined;
}

/**
 * Path prefixes that bypass the maintenance gate. `isMaintenanceExempt`
 * walks this list once per request — cheap prefix match, no regex
 * compilation in the hot path.
 *
 * `readonly` + `as const` gives the array a literal type so adding a
 * new exempt path is a deliberate edit rather than an accidental
 * mutation. Order does not matter; the check is purely boolean-OR.
 */
const EXEMPT_PREFIXES = [
  '/admin',
  '/api/internal/admin',
  '/api/v1/health',
  '/api/v1/status',
  '/status',
  '/_next',
  '/assets',
  '/favicon',
] as const;

/**
 * Return true when the request path should be allowed through even
 * when `CRIVACY_MAINTENANCE_MODE` is on.
 *
 * The check uses exact-prefix-with-boundary — a prefix matches only
 * when the next character is `/` (child route) or `.` (file suffix
 * like `favicon.ico`) or end-of-string. Prevents a sneaky route like
 * `/adminfoo` or `/statusboard` from bypassing the gate via name
 * collision.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  for (const prefix of EXEMPT_PREFIXES) {
    if (pathname === prefix) return true;
    if (pathname.length > prefix.length && pathname.startsWith(prefix)) {
      const nextChar = pathname.charAt(prefix.length);
      if (nextChar === '/' || nextChar === '.') return true;
    }
  }
  return false;
}
