/**
 * Pwned Passwords check — k-anonymity lookup against the
 * HaveIBeenPwned `/range/{prefix}` endpoint.
 *
 * Credential-stuffing attacks re-use passwords leaked in public breach
 * dumps. A password like `MyPassword123!` clears every structural
 * strength rule (length + classes) yet appears hundreds of thousands
 * of times in dumps like RockYou2024, Collection#1, LinkedIn 2012.
 * Blocking those known-bad inputs at the register / reset / change
 * boundary is the single highest-value defence a public auth surface
 * can add beyond basic complexity rules — this is what 1Password,
 * GitHub, Okta, Auth0, Chrome Password Checkup and Firefox Monitor
 * all do.
 *
 * ## Privacy
 *
 * The password never leaves the Node process. We SHA-1 hash the
 * plaintext, send **only the first 5 hex characters** of the digest
 * to the HIBP API, then search the returned suffix list locally.
 * This is the k-anonymity scheme HIBP publishes — the API server
 * cannot tell which of the ~600 hash suffixes in the prefix bucket
 * was the one we cared about.
 *
 * Why SHA-1 is acceptable here despite its collision weakness: we
 * are not authenticating or signing anything. We are joining our
 * hashed password against a precomputed rainbow table of leaked
 * hashes. Both sides hash the same way, and collision strength is
 * irrelevant to the correctness of a set-membership test.
 *
 * ## Failure mode
 *
 * The checker is **fail-open** by default: if HIBP is unreachable,
 * times out, or returns malformed data, we return `{ pwned: false }`
 * so a legitimate user can still set their password during an HIBP
 * outage. A log line is emitted so we can notice repeated failures.
 * The cost of false-negatives (accepting a breached password) during
 * an outage is strictly smaller than the cost of false-positives
 * (locking everyone out of self-service password flows) during the
 * same outage.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { getRootLogger } from '@/lib/observability/logger';

/**
 * How many times a password must appear in the HIBP corpus before we
 * reject it. `1` — the default — means "any breach at all"; pick a
 * higher number to match a laxer policy (some deployments use 10 or
 * 100 as a compromise between friction and safety).
 */
export const DEFAULT_PWN_THRESHOLD = 1;

/**
 * Network timeout for the HIBP lookup. Short — we are blocking a
 * register / reset flow on this. HIBP's p95 is ~150 ms from US/EU.
 */
export const HIBP_TIMEOUT_MS = 3000;

/**
 * User-Agent header required by HIBP terms of use. The string is a
 * stable identifier so HIBP's operators can reach out if our traffic
 * ever looks abusive; it does not encode PII.
 */
const HIBP_USER_AGENT = 'Crivacy-KYC/1.0 (password-safety-check)';

export interface PwnedCheckResult {
  /** `true` when the password's SHA-1 hash is in the HIBP corpus. */
  readonly pwned: boolean;
  /** Number of times the password appears in breach dumps. `0` when not pwned or the check failed. */
  readonly count: number;
  /**
   * `true` when the HIBP request succeeded (regardless of whether
   * the password was pwned). Callers do not usually need to look at
   * this; it exists so tests can assert on transport behaviour.
   */
  readonly checked: boolean;
}

/**
 * Look up `password` against the HIBP Pwned Passwords corpus.
 *
 * Returns `{ pwned, count, checked }`. `pwned` is `true` only when
 * both of the following hold:
 *
 *   1. The lookup completed successfully (`checked === true`), AND
 *   2. The password's SHA-1 hash was returned with
 *      `count >= threshold`.
 *
 * Use {@link isPasswordPwned} for a simple boolean guard, or
 * {@link assertPasswordNotPwned} to throw on a hit.
 */
export async function checkPasswordPwned(
  password: string,
  options?: {
    readonly threshold?: number;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  },
): Promise<PwnedCheckResult> {
  const threshold = options?.threshold ?? DEFAULT_PWN_THRESHOLD;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? HIBP_TIMEOUT_MS;

  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method: 'GET',
      headers: {
        'User-Agent': HIBP_USER_AGENT,
        // Opt-in padding so the response length does not leak which
        // suffix bucket we hit (HIBP documents this header). Harmless
        // if unsupported — older responses just ignore it.
        'Add-Padding': 'true',
      },
      signal: controller.signal,
    });
  } catch (err) {
    // Network / abort / DNS — fail-open so legit users can still
    // reset their password during an HIBP outage.
    getRootLogger().warn(
      {
        event: 'pwned_passwords_lookup_failed',
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'pwned-passwords lookup failed, allowing password',
    );
    return { pwned: false, count: 0, checked: false };
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    getRootLogger().warn(
      { event: 'pwned_passwords_http_error', httpStatus: response.status },
      'pwned-passwords HTTP error from HIBP, allowing password',
    );
    return { pwned: false, count: 0, checked: false };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    getRootLogger().warn(
      {
        event: 'pwned_passwords_body_read_failed',
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'pwned-passwords body read failed, allowing password',
    );
    return { pwned: false, count: 0, checked: false };
  }

  // Response is `SUFFIX:COUNT` lines separated by CRLF. HIBP may pad
  // the response with bogus zero-count entries when `Add-Padding: true`
  // is sent — those are harmless to ignore since the real hit for a
  // breached password always has a non-zero count.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;
    const hashSuffix = line.slice(0, colonIndex);
    if (hashSuffix !== suffix) continue;
    const count = Number.parseInt(line.slice(colonIndex + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (count >= threshold) {
      return { pwned: true, count, checked: true };
    }
  }
  return { pwned: false, count: 0, checked: true };
}

/**
 * Convenience boolean — `true` when the password was found in the
 * HIBP corpus at or above the configured threshold. Swallows all
 * transport failures via {@link checkPasswordPwned}'s fail-open path.
 */
export async function isPasswordPwned(
  password: string,
  threshold = DEFAULT_PWN_THRESHOLD,
): Promise<boolean> {
  const result = await checkPasswordPwned(password, { threshold });
  return result.pwned;
}

/**
 * Convenience error constructor used by handlers that want a single
 * throw-site. Callers catch their own layer-specific error class
 * (`CustomerError`, `AuthError`) and translate, so we surface a
 * plain `Error` subclass with a stable `code` field.
 */
export class PwnedPasswordError extends Error {
  readonly code = 'pwned_password' as const;
  readonly breachCount: number;

  constructor(breachCount: number) {
    super(
      'This password has appeared in a data breach and can no longer be used. Please choose a different password.',
    );
    this.name = 'PwnedPasswordError';
    this.breachCount = breachCount;
  }
}

/**
 * Throws {@link PwnedPasswordError} when `password` is in the HIBP
 * corpus at or above `threshold`. Handlers should catch this and
 * surface their layer-specific error code (e.g. `weak_password` for
 * customer routes) so the caller sees a consistent shape.
 */
export async function assertPasswordNotPwned(
  password: string,
  threshold = DEFAULT_PWN_THRESHOLD,
): Promise<void> {
  const result = await checkPasswordPwned(password, { threshold });
  if (result.pwned) {
    throw new PwnedPasswordError(result.count);
  }
}
