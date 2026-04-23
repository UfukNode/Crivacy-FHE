/**
 * Centralised access to `NEXT_PUBLIC_APP_URL`.
 *
 * Before this module existed, 22 call-sites read the env variable
 * directly with ad-hoc fallbacks — a mix of `?? ''`, hardcoded
 * `https://app.crivacy.io`, and one `https://crivacy.io`. The
 * practical failure modes:
 *
 *   * Silent empty fallback: an email link rendered as `/tickets/<id>`
 *     with no host — the recipient's mail client either refuses to
 *     linkify it or 404s on click.
 *   * Hardcoded `app.crivacy.io` fallback: if the domain ever changes,
 *     the ops grep-and-replace miss bricks production emails. Also
 *     violates the project-wide "no hardcoded fallbacks" rule in
 *     `CLAUDE.md`.
 *   * No prod https guard: misconfigured deployments shipping
 *     `http://` in emails bypass HSTS on first click, opening a
 *     downgrade window. Pairs with the HSTS preload submission
 *     follow-up (INFO-27-004).
 *
 * Every consumer now calls {@link getAppUrl}; behaviour is:
 *
 *   * `NODE_ENV=production` + env missing/empty → throw. Fail-loud at
 *     first request so the platform healthcheck catches the misconfig.
 *   * `NODE_ENV=production` + env is not `https://` → throw (same
 *     reason — the email-link integrity story only works if the base
 *     URL is TLS-sealed end-to-end).
 *   * `NODE_ENV=test` or `NODE_ENV=development` with env missing →
 *     return the dev-server default (`http://localhost:3001`) so
 *     tests + local dev keep working without a set env.
 *
 * The result is memoised per process so subsequent calls are free.
 */

const DEV_DEFAULT = 'http://localhost:3001';

let cachedValue: string | null | undefined;

/**
 * Resolve the configured application base URL. Throws in production
 * when the env is missing or not `https://`; falls back to the
 * localhost dev default otherwise.
 *
 * The returned string has no trailing slash so callers can always
 * concatenate `${appUrl}/path`.
 */
export function getAppUrl(): string {
  if (cachedValue !== undefined) {
    if (cachedValue === null) {
      throw new Error(
        '[app-url] NEXT_PUBLIC_APP_URL is required in production. Set the env' +
          ' to the public HTTPS origin of this deployment before starting the' +
          ' server (e.g. NEXT_PUBLIC_APP_URL=https://app.crivacy.io).',
      );
    }
    return cachedValue;
  }

  const raw = process.env['NEXT_PUBLIC_APP_URL'];
  const trimmed = raw?.trim() ?? '';

  if (trimmed.length === 0) {
    if (process.env['NODE_ENV'] === 'production') {
      cachedValue = null;
      throw new Error(
        '[app-url] NEXT_PUBLIC_APP_URL is required in production. Set the env' +
          ' to the public HTTPS origin of this deployment before starting the' +
          ' server (e.g. NEXT_PUBLIC_APP_URL=https://app.crivacy.io).',
      );
    }
    cachedValue = DEV_DEFAULT;
    return cachedValue;
  }

  // Audit-mode override (Adım 5.5 runtime fix-verify): allow http on
  // localhost OR any RFC 1918 private LAN IP when
  // CRIVACY_AUDIT_LOCAL_HTTP=true. Lets prod-mode workers run on a dev
  // box without TLS termination AND lets a phone on the same wifi
  // resolve the dev server (handoff QR flow). Real prod still enforces
  // https://. The LAN ranges are:
  //   - 10.0.0.0/8
  //   - 172.16.0.0/12
  //   - 192.168.0.0/16
  const auditLocalHttp = process.env['CRIVACY_AUDIT_LOCAL_HTTP'] === 'true';
  const privateHostOk = auditLocalHttp &&
    /^http:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/.test(trimmed);
  if (process.env['NODE_ENV'] === 'production' && !trimmed.startsWith('https://') && !privateHostOk) {
    cachedValue = null;
    throw new Error(
      '[app-url] NEXT_PUBLIC_APP_URL must start with https:// in production.' +
        ' Email-link integrity + HSTS preload require a TLS origin — plain http' +
        ' also bypasses `upgrade-insecure-requests` on the first click.',
    );
  }

  cachedValue = trimmed.replace(/\/+$/, '');
  return cachedValue;
}

/** Test-only helper — drop the memoised env read so per-case overrides apply. */
export function resetAppUrlForTests(): void {
  cachedValue = undefined;
}
