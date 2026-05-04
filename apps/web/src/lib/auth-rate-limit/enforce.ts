/**
 * Per-IP sliding-window rate limiter for credential-accepting auth
 * endpoints.
 *
 * Complementary to `lib/ratelimit/*` which gates apiKey-authenticated
 * traffic on `/api/v1/*`. That limiter is keyed on `apiKeyId` +
 * firm tier — useless for the customer / firm / admin auth surfaces
 * where the caller is by definition unauthenticated. This module
 * fills the gap with a hashed-IP sliding window.
 *
 * Design choices:
 *   - Sliding window instead of token-bucket so a single burst above
 *     the cap gets a clean "retry after N seconds" without carrying
 *     refill debt into subsequent windows.
 *   - Hashed IP (SHA-256). We never write a raw client IP to the
 *     rate-limit table — GDPR posture + limits damage if the row
 *     leaks.
 *   - Opportunistic cleanup — every `enforceAuthRateLimit` call
 *     prunes rows older than a global retention cutoff so the table
 *     never grows unbounded without a dedicated sweeper.
 *   - Never-throws on DB failure. If the write fails, we log and
 *     let the request through rather than lock the whole login
 *     surface out on a transient DB blip. This is the conservative
 *     operational choice — the alternative (fail-closed) would turn
 *     a primary-DB hiccup into a total-auth outage.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';

import { sql } from 'drizzle-orm';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';

/**
 * Catalogue of every rate-limited endpoint key. Keeping it as a
 * typed union means a caller typo becomes a compile error rather
 * than a silent new bucket.
 */
export type AuthRateLimitEndpoint =
  | 'customer_login'
  | 'customer_register'
  | 'customer_forgot_password'
  | 'customer_verify_reset_code'
  | 'customer_reset_password'
  | 'customer_verify_email'
  | 'customer_resend_verification'
  // Cookie-based refresh rotation. User interaction yok (background /
  // reactive-401 path), Turnstile uygulanmıyor. Per-IP cap bir stolen
  // refresh cookie'nin sınırsız access-token mint etmesini engeller —
  // meşru trafikte 1 proactive (13dk'da bir) + ~5 reactive/dk worst
  // case, 20/60s eşiği ile headroom bol. Aynı pattern 3 audience'da.
  | 'customer_refresh'
  // Authenticated profile surfaces. A stolen session cookie lets an
  // attacker reach these endpoints; without a per-IP cap they turn
  // into brute-force oracles for the `current password` field on
  // change-password, or into silent-takeover chains on set-password
  // and wallet-link. The caps are intentionally strict — legitimate
  // users rotate a password at most a handful of times a year, so
  // even 5 attempts per 15 min is extremely generous while still
  // shutting down any high-rate probing.
  | 'customer_change_password'
  | 'customer_set_password'
  | 'customer_add_email'
  | 'customer_change_email'
  | 'customer_verify_email_change'
  | 'customer_wallet_link'
  | 'customer_wallet_unlink'
  // User-triggered NFT mint (Enhanced credential customer-facing
  // showcase artefact). The mint is one chain submission per click;
  // this cap shuts down brute-force theme-flipping attempts where a
  // customer rapidly remints to find a "preferred" rendering. Enhanced
  // credentials are minted at most once per onboarding flow under
  // normal use, so 5/15min is generous.
  | 'customer_mint_nft'
  // Customer-side Google OAuth surface. F-A2-001 closure: previously
  // un-rate-limited. Caps differ per endpoint shape; see POLICIES
  // for the full rationale.
  | 'customer_oauth_initiate'
  | 'customer_oauth_callback'
  | 'customer_oauth_unlink'
  | 'customer_profile_update'
  | 'customer_avatar_upload'
  | 'customer_avatar_delete'
  // Ticket attachment upload — 5 MiB body + sharp re-encode (strip
  // EXIF + resize). Parallels `customer_avatar_upload` in cost.
  // Without a cap, a stolen session can fill disk + starve CPU.
  | 'customer_ticket_attachment_upload'
  // GDPR data export — aggregates customer's full data graph into a
  // JSON payload. Expensive to generate (joins across 6+ tables) and
  // the result can be >1 MB for long-lived customers. Tight cap so
  // a stolen session can't spam downloads.
  | 'customer_data_export'
  // GDPR erasure — terminal, irreversible. Rate limit purely as a
  // defence against a stolen session "trolling" the customer. Legit
  // flow runs exactly once; 3/day window is generous for retry after
  // a transient failure.
  | 'customer_erasure'
  | 'customer_notifications_preferences'
  | 'firm_login'
  | 'firm_forgot_password'
  | 'firm_verify_reset_code'
  | 'firm_reset_password'
  | 'firm_refresh'
  // Firm authenticated profile surfaces. A stolen session cookie plus
  // a stolen password could otherwise silently rotate TOTP or pop the
  // 2FA protection off entirely. Tight per-IP caps on each — these
  // ops are intrinsically rare for any single user.
  | 'firm_totp_replace'
  | 'firm_totp_disable'
  | 'firm_totp_setup'
  | 'firm_recovery_codes_regenerate'
  | 'firm_profile_update'
  | 'firm_users_invite'
  | 'firm_users_role_change'
  | 'firm_users_remove'
  | 'admin_login'
  | 'admin_verify_totp'
  | 'admin_refresh'
  // Admin profile surfaces mirror the firm ones — 5/15min on the
  // TOTP management trio, stricter than the `admin_login` bucket
  // because legitimate TOTP rotation happens once a year per admin
  // at most.
  | 'admin_totp_setup'
  | 'admin_totp_replace'
  | 'admin_totp_disable'
  | 'admin_recovery_codes_regenerate'
  | 'admin_change_password'
  // OAuth public endpoints. Each has a different threat shape, so
  // each one passes a different caller-key to this helper:
  //   - `oauth_authorize` is user-initiated from a browser → per-IP.
  //   - `oauth_token` is server-to-server from the firm backend →
  //     per-`client_id` (the firm's app identifier) so one firm's
  //     workload can't starve another's and a single client brute-
  //     forcing secrets gets capped even as source IPs rotate.
  //   - `oauth_userinfo` is Bearer-authed per access token →
  //     per-`sha256(access_token)` so a leaked token being spammed
  //     has a ceiling.
  //
  // The `ip` parameter of `enforceAuthRateLimit` is misnamed for
  // these endpoints — semantically it's a "caller key" that the
  // function hashes before storing. See the POLICIES block for
  // per-endpoint caps.
  | 'oauth_authorize'
  | 'oauth_token'
  | 'oauth_userinfo'
  // User-facing consent surface. Per-customer key because a single
  // IP can hold many users (office NAT, ISP CGNAT) and we want a
  // malicious browser on one of them not to starve the others.
  | 'oauth_consent_submit'
  // Per-IP on the bootstrap read because it's unauthenticated-ish
  // (cookie-gated) and called once per page load. Generous window
  // to cover retries after 401.
  | 'oauth_consent_bootstrap'
  // Per-customer key — `/kyc?continue=…` mints session state and
  // potentially fires Didit calls. Keep the cap strict because the
  // upstream provider bills per session.
  | 'kyc_start';

export interface AuthRateLimitPolicy {
  /** Max attempts permitted inside the window. */
  readonly max: number;
  /** Window size in seconds (sliding). */
  readonly windowSeconds: number;
}

/**
 * Per-endpoint policy. Tighter on credential-guessing surfaces
 * (login), looser on flows a legitimate user retries under normal
 * conditions (reset code entry). Every value here is tunable at
 * deploy time via env if we ever need regional overrides, but the
 * defaults are deliberately strict: we'd rather annoy a handful of
 * power users than leave the door open to credential-stuffing bots.
 */
const POLICIES: Readonly<Record<AuthRateLimitEndpoint, AuthRateLimitPolicy>> = {
  customer_login: { max: 10, windowSeconds: 60 },
  // Refresh cookie rotation — background proactive timer (her 13dk) +
  // reactive 401 retry. 20/60s cap meşru trafiğe >>5x headroom bırakır,
  // attacker için brute rotation ceiling olur.
  customer_refresh: { max: 20, windowSeconds: 60 },
  customer_register: { max: 5, windowSeconds: 15 * 60 },
  customer_forgot_password: { max: 5, windowSeconds: 15 * 60 },
  customer_verify_reset_code: { max: 20, windowSeconds: 15 * 60 },
  customer_reset_password: { max: 20, windowSeconds: 15 * 60 },
  customer_verify_email: { max: 20, windowSeconds: 15 * 60 },
  customer_resend_verification: { max: 5, windowSeconds: 15 * 60 },
  // Authenticated profile endpoints — per-IP cap defends against a
  // stolen-cookie attacker who would otherwise spam the endpoint.
  // 5/15min is generous enough that a legitimate user who mistypes
  // their current password a handful of times never hits it, and
  // tight enough that argon2's ~100ms verify cost plus this cap
  // eliminates any realistic brute-force attempt on the current-
  // password field.
  customer_change_password: { max: 5, windowSeconds: 15 * 60 },
  // `set-password` is idempotent (409 after first success), but an
  // attacker could still spam the endpoint to generate notification-
  // email noise. 5/15min matches change-password.
  customer_set_password: { max: 5, windowSeconds: 15 * 60 },
  // `add-email` is the first half of the wallet-only takeover chain
  // (attacker adds own email → set-password → login from anywhere).
  // `set-password` already requires a wallet signature for email-
  // less customers; this cap keeps the per-IP volume low so a
  // stolen session cannot probe-and-spam either leg. 5/15min matches
  // the other two legs of the chain.
  customer_add_email: { max: 5, windowSeconds: 15 * 60 },
  // `wallet-link` cost is higher (challenge JWT + wallet extension
  // signing), so 10/15min gives room for retries when the extension
  // flakes out. The real defence against wallet-link replay is the
  // per-nonce burn in `wallet_nonces_used`; this is defence-in-depth.
  customer_wallet_link: { max: 10, windowSeconds: 15 * 60 },
  // NFT mint cap — same shape as wallet_link (chain chain submission
  // per call). 5/15min is well above any legitimate user pattern; the
  // CAS guard on `kyc_credentials_meta.nft_contract_id` is the
  // primary correctness defence (one NFT per credential, race-safe).
  customer_mint_nft: { max: 5, windowSeconds: 15 * 60 },
  // OAuth (Google) endpoints. F-A2-001 (Page 2 closure batch): the
  // initiate / callback / unlink trio was previously un-rate-limited;
  // these caps mirror the email+password login parite (10/min on
  // human-driven entry points, 30/min on the IdP-bouncing callback
  // because retries during a Google consent loop are legitimate).
  // The rationale lives in the same neighbourhood as
  // `oauth_authorize` on the firm-side OAuth surface — different
  // threat shape (customer login vs API client minting) but the same
  // "credential-creation surface needs a per-IP floor" principle.
  customer_oauth_initiate: { max: 10, windowSeconds: 60 },
  // Callback runs after Google's cross-origin bounce — the state JWT
  // + nonce cookie pair is the anti-replay primary, this cap is a
  // secondary defence against a cookie-thieved state being walked
  // through harvested codes. 30/min absorbs legitimate retries and
  // shuts down a script.
  customer_oauth_callback: { max: 30, windowSeconds: 60 },
  // Unlink mirrors `customer_wallet_unlink` (Cat 14 credential-
  // mutation). 5/15min because legitimate unlink fires at most once
  // per credential rotation; the cap is the spam ceiling against a
  // stolen session that would otherwise hammer audit log entries.
  customer_oauth_unlink: { max: 5, windowSeconds: 15 * 60 },
  // `wallet-unlink` has no signature — just session-auth'd DELETE.
  // Idempotent (404 after first). Low ceiling to cap abuse-spam of
  // the notification side-effects we'll add later if needed.
  customer_wallet_unlink: { max: 5, windowSeconds: 15 * 60 },
  // Email change + verify. change-email already caps per-user via the
  // email_verification_tokens row count, but that defends against a
  // single authenticated attacker spamming their own inbox, not
  // against a session-stealing attacker probing the enumeration
  // branch — hence the IP-level cap.
  customer_change_email: { max: 5, windowSeconds: 15 * 60 },
  // verify-email-change already enforces per-token attempts. The
  // IP cap protects against parallel-submission attacks that could
  // race a pre-atomic attempts counter (historically H2 — now fixed
  // by the atomic verifyEmailCode primitive, but defence-in-depth).
  customer_verify_email_change: { max: 20, windowSeconds: 15 * 60 },
  // Profile PATCH (displayName / phone / onboarding). Legitimate use
  // fires a handful of times per session; 30/15min is well above any
  // human click rate while capping stolen-session audit-log spam.
  customer_profile_update: { max: 30, windowSeconds: 15 * 60 },
  // Avatar upload ships 2 MiB + sharp CPU; stricter than the generic
  // profile cap because each request has a non-trivial cost.
  customer_avatar_upload: { max: 10, windowSeconds: 15 * 60 },
  // Avatar delete is cheap + idempotent; mirror profile cap.
  customer_avatar_delete: { max: 30, windowSeconds: 15 * 60 },
  // Ticket attachment upload: 5 MiB + sharp re-encode. Looser than
  // avatar (20/15min) because a support thread may legitimately have
  // multiple screenshots per message.
  customer_ticket_attachment_upload: { max: 20, windowSeconds: 15 * 60 },
  // GDPR data export: expensive JSON aggregation; 3/day is ample for
  // "download my data then retry after an hour if the UI hiccups."
  customer_data_export: { max: 3, windowSeconds: 24 * 60 * 60 },
  // GDPR erasure: destructive + irreversible. 3/day allows a retry
  // loop for a transient failure but shuts down abuse.
  customer_erasure: { max: 3, windowSeconds: 24 * 60 * 60 },
  // Notifications preferences PATCH. Batched writes (one per event
  // type in the array); a stolen session could otherwise toggle
  // hundreds of preference rows in rapid succession.
  customer_notifications_preferences: { max: 30, windowSeconds: 15 * 60 },
  firm_login: { max: 10, windowSeconds: 60 },
  firm_refresh: { max: 20, windowSeconds: 60 },
  firm_forgot_password: { max: 5, windowSeconds: 15 * 60 },
  firm_verify_reset_code: { max: 20, windowSeconds: 15 * 60 },
  firm_reset_password: { max: 20, windowSeconds: 15 * 60 },
  // Firm profile TOTP management. 5/15min per IP is intentionally
  // strict — these endpoints only run when a user is intentionally
  // reconfiguring 2FA from settings, which no legitimate user does
  // more than once a day.
  firm_totp_replace: { max: 5, windowSeconds: 15 * 60 },
  firm_totp_disable: { max: 5, windowSeconds: 15 * 60 },
  firm_recovery_codes_regenerate: { max: 5, windowSeconds: 15 * 60 },
  // `/auth/totp/setup` mints a candidate secret + QR each time. The
  // result is not persisted (verify-step binds it), but an attacker
  // with a session can burn randomness pool + generate noise in the
  // setup audit stream. 20/15min is very generous for legitimate
  // re-scans during setup and still shuts down a spam loop.
  firm_totp_setup: { max: 20, windowSeconds: 15 * 60 },
  // Firm profile PATCH. Legitimate admins edit the firm profile a
  // handful of times a week; 20/15min is the "definitely human" floor
  // while still capping a stolen-session abuse vector that would
  // otherwise spam audit log entries.
  firm_profile_update: { max: 20, windowSeconds: 15 * 60 },
  // Team-management endpoints. Inviting fires a transactional email
  // to the invitee — stricter cap than profile ops because that side
  // effect is visible outside the firm. Role changes and removals are
  // cheaper but still audit-visible; 20/15min matches the profile cap.
  firm_users_invite: { max: 10, windowSeconds: 15 * 60 },
  firm_users_role_change: { max: 20, windowSeconds: 15 * 60 },
  firm_users_remove: { max: 20, windowSeconds: 15 * 60 },
  admin_login: { max: 10, windowSeconds: 60 },
  admin_verify_totp: { max: 10, windowSeconds: 60 },
  admin_refresh: { max: 20, windowSeconds: 60 },
  // Admin settings — same threat model as the firm side but admins
  // touch these even less often. 20/15min on setup matches firm;
  // 5/15min on mutating endpoints matches firm.
  admin_totp_setup: { max: 20, windowSeconds: 15 * 60 },
  admin_totp_replace: { max: 5, windowSeconds: 15 * 60 },
  admin_totp_disable: { max: 5, windowSeconds: 15 * 60 },
  admin_recovery_codes_regenerate: { max: 5, windowSeconds: 15 * 60 },
  admin_change_password: { max: 5, windowSeconds: 15 * 60 },
  // OAuth — per-IP bucket for authorize is calm (30/min is far
  // above any legitimate user-initiated rate). Token is keyed
  // per-client so a busy firm isn't capped by a single IP bucket;
  // 20/min allows every pending code exchange in a 60s TTL window
  // plus healthy headroom. Userinfo is keyed per access-token and
  // 60/min cuts off a leaked-token spray without tripping a normal
  // firm that re-fetches user claims on every request to a hot
  // route.
  oauth_authorize: { max: 30, windowSeconds: 60 },
  oauth_token: { max: 20, windowSeconds: 60 },
  oauth_userinfo: { max: 60, windowSeconds: 60 },
  // Consent submit — per-customer. 10/min is well above any human
  // "oops clicked twice" pattern but cuts off a scripted spam that
  // would blow up the consent cache and webhook fan-out.
  oauth_consent_submit: { max: 10, windowSeconds: 60 },
  // Consent page bootstrap — per-IP. Legitimate users hit it on
  // page load plus one retry after login, so 30/min has huge
  // headroom while still shutting down a fetch-in-a-loop attack.
  oauth_consent_bootstrap: { max: 30, windowSeconds: 60 },
  // KYC entry — per-customer. 5/min because each click may mint a
  // Didit session (billed per start) and there is no legitimate
  // reason to retry this fast. Double-click guard on the button
  // handles the UI side; this is the backend floor.
  kyc_start: { max: 5, windowSeconds: 60 },
};

/**
 * Longest window across all policies. Rows older than this are
 * safe to delete on any enforce call — they can't contribute to
 * any future window count.
 */
const RETENTION_SECONDS = Math.max(
  ...Object.values(POLICIES).map((p) => p.windowSeconds),
);

/**
 * Collapse an IPv6 address to its `/64` prefix before bucketing. A
 * single attacker typically holds an entire `/64` subnet (standard
 * residential + VPS allocation), so hashing the full 128 bits would
 * let them rotate the low 64 bits freely and land in a different
 * bucket on every request — trivially bypassing any IP-based cap.
 * Collapsing to `/64` pins every address in that subnet to the same
 * bucket. IPv4 addresses are returned unchanged.
 *
 * Handles the edge cases that routinely appear in real traffic:
 *   - Zone identifiers (`fe80::1%eth0`) — stripped before parsing.
 *   - Compressed notation (`::` gap) — expanded before truncation.
 *   - IPv4-mapped IPv6 (`::ffff:1.2.3.4`) — the dotted tail is
 *     converted to two hex groups so the parser can count groups
 *     correctly; the `/64` prefix is all-zeros in this case, which
 *     is still the desired single-bucket behaviour because legitimate
 *     IPv4-mapped traffic arrives in the same bucket anyway.
 *
 * Anything that fails to parse falls through to the original string
 * — degraded collapse is better than throwing on malformed input and
 * killing the rate-limit check.
 */
export function normalizeIpForBucket(ip: string): string {
  const cleaned = ip.split('%')[0] ?? ip;
  if (!isIPv6(cleaned)) return ip;
  const parts = cleaned.split('::');
  if (parts.length > 2) return ip;

  const convertTail = (tail: string): string[] => {
    if (tail.length === 0) return [];
    const groups = tail.split(':');
    const last = groups[groups.length - 1];
    if (last !== undefined && last.includes('.')) {
      const octets = last.split('.').map((o) => Number.parseInt(o, 10));
      if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
        return groups;
      }
      const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
      const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
      return [...groups.slice(0, -1), hi, lo];
    }
    return groups;
  };

  const left = convertTail(parts[0] ?? '');
  const right = parts.length === 2 ? convertTail(parts[1] ?? '') : [];
  const gap = 8 - (left.length + right.length);
  if (gap < 0) return ip;
  if (parts.length === 1 && gap !== 0) return ip;
  const full = [...left, ...new Array(gap).fill('0'), ...right];
  if (full.length !== 8) return ip;
  const prefix = full
    .slice(0, 4)
    .map((g) => g.padStart(4, '0').toLowerCase())
    .join(':');
  return `${prefix}::/64`;
}

/**
 * Hash a raw IP string for storage. Returns a deterministic 64-char
 * lowercase hex digest. Stable across processes so the same client
 * hits the same bucket across a multi-replica deployment. IPv6
 * addresses are collapsed to their `/64` prefix first — see
 * `normalizeIpForBucket` for the rationale.
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(normalizeIpForBucket(ip)).digest('hex');
}

export interface AuthRateLimitDecision {
  readonly allowed: boolean;
  /** When denied, seconds until the oldest blocking hit falls out of the window. */
  readonly retryAfterSeconds: number;
  /** Attempts already made in the current window (includes this one). */
  readonly attempts: number;
  readonly max: number;
}

/**
 * Enforce the policy for `endpoint` against the supplied client IP.
 *
 * When `ip` is null — i.e. the request came in without a resolvable
 * address, which can happen behind a misconfigured proxy — we do
 * NOT lock the caller out. Fail-open on IP absence is the safer
 * default for a first-layer defence; the inner auth guards (bad
 * password returns 401, bad code increments a separate counter)
 * still run.
 */
export async function enforceAuthRateLimit(
  db: CrivacyDatabase,
  endpoint: AuthRateLimitEndpoint,
  ip: string | null,
  now: Date = new Date(),
): Promise<AuthRateLimitDecision> {
  const policy = POLICIES[endpoint];

  if (ip === null || ip.length === 0) {
    return { allowed: true, retryAfterSeconds: 0, attempts: 0, max: policy.max };
  }

  const ipHash = hashIp(ip);
  const windowStart = new Date(now.getTime() - policy.windowSeconds * 1000);
  const retentionCutoff = new Date(now.getTime() - RETENTION_SECONDS * 1000);

  try {
    // Opportunistic janitor — best-effort cleanup of old rows. Non-
    // blocking semantically: if this DELETE fails the window count
    // would still be correct (just with extra rows to scan).
    await db.execute(
      sql`DELETE FROM auth_rate_limit_events WHERE created_at < ${retentionCutoff.toISOString()}`,
    );

    // Record this attempt BEFORE counting, so an attacker that pipes
    // requests at exactly the boundary still has this hit counted
    // against them.
    await db.execute(
      sql`INSERT INTO auth_rate_limit_events (endpoint, ip_hash, created_at)
          VALUES (${endpoint}, ${ipHash}, ${now.toISOString()})`,
    );

    // Count attempts inside the sliding window.
    const countResult = await db.execute<{ count: string; oldest: string | null }>(
      sql`SELECT COUNT(*)::text AS count,
                 MIN(created_at)::text AS oldest
            FROM auth_rate_limit_events
           WHERE endpoint = ${endpoint}
             AND ip_hash = ${ipHash}
             AND created_at > ${windowStart.toISOString()}`,
    );
    const row = countResult.rows[0] as { count: string; oldest: string | null } | undefined;
    const attempts = Number.parseInt(row?.count ?? '0', 10);

    if (attempts <= policy.max) {
      return { allowed: true, retryAfterSeconds: 0, attempts, max: policy.max };
    }

    // Over the cap — compute retry-after as the time until the
    // oldest hit in the window expires. Falls back to the full
    // window if somehow the query returned a null oldest.
    let retryAfterSeconds = policy.windowSeconds;
    if (row?.oldest) {
      const oldestAt = new Date(row.oldest);
      const expiresAt = new Date(oldestAt.getTime() + policy.windowSeconds * 1000);
      retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
    }

    // F-A1-J5-001 — window-edge audit. Emit exactly once per burst:
    // the request that flips `attempts` from `policy.max` to
    // `policy.max + 1`. Subsequent in-window denials see
    // `attempts > policy.max + 1` and skip the emit, so SOC
    // dashboards see a single forensic row per burst rather than a
    // log flood. Wrapped in a local try/catch so an audit-side
    // failure cannot escalate into the outer DB-error fail-open and
    // silently downgrade a deny into an allow. Single action key
    // (`auth.rate_limit_fired`) for every endpoint; `meta.endpoint`
    // is the discriminator.
    if (attempts === policy.max + 1) {
      try {
        await writeAudit(db, {
          action: 'auth.rate_limit_fired',
          actor: systemActor('auth-rate-limit'),
          target: noTarget(),
          context: buildAuditContext({ ip, userAgent: null, requestId: null }),
          meta: {
            endpoint,
            attempts,
            max: policy.max,
            retryAfterSeconds,
            windowSeconds: policy.windowSeconds,
          },
          ts: now,
        });
      } catch (auditErr) {
        getRootLogger().error(
          {
            event: 'rate_limit_audit_emit_failed',
            endpoint,
            err:
              auditErr instanceof Error
                ? { name: auditErr.name, message: auditErr.message }
                : String(auditErr),
          },
          'rate_limit_audit_emit_failed — could not write window-edge audit row',
        );
      }
    }

    return { allowed: false, retryAfterSeconds, attempts, max: policy.max };
  } catch (err) {
    // Fail-open on DB error — a transient outage on the rate-limit
    // path must not lock the whole auth surface. Structured log so a
    // Loki query on `event="rate_limit_fail_open"` pages oncall when
    // this fires more than N times per minute (AUD-X-RATELIMIT-001
    // monitoring signal hook). The string key `rate_limit_fail_open`
    // is stable across releases — alerts depend on it.
    getRootLogger().error(
      {
        event: 'rate_limit_fail_open',
        endpoint,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'rate_limit_fail_open — DB error, request allowed',
    );
    return { allowed: true, retryAfterSeconds: 0, attempts: 0, max: policy.max };
  }
}
