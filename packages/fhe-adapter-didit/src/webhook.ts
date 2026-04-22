/**
 * Webhook signature verification + body parsing for the Didit KYC
 * provider.
 *
 * Didit's webhook dispatcher ships two signatures on every inbound
 * request, either of which we can accept:
 *
 *   * **`X-Signature-V2`** (primary) — hex-encoded HMAC-SHA256 over
 *     the canonical JSON of the webhook body. "Canonical" means the
 *     body is run through `shortenFloats` + `sortKeys` (see
 *     `canonical.ts`) and then serialized with `JSON.stringify` in
 *     its default tight form (`,` + `:` with no spaces and no
 *     trailing newline). Python's
 *     `json.dumps(obj, separators=(',', ':'), sort_keys=True)`
 *     produces the exact same byte string.
 *
 *   * **`X-Signature-Simple`** (fallback) — hex-encoded HMAC-SHA256
 *     over the concatenation
 *
 *         `${timestamp}:${session_id}:${status}:${webhook_type}`
 *
 *     Used only when the full body HMAC cannot be reproduced
 *     (e.g. a body re-serialized by an intermediate proxy). The
 *     four-field form covers the only mutable content we care about
 *     for replay protection. Consumers opt in via the config.
 *
 * All signatures also require `X-Timestamp` (Unix seconds integer)
 * and are rejected outside the `webhookDriftSeconds` window. Every
 * failure mode maps to a dedicated `DiditError` code so the webhook
 * route can return `401 + tamper-evident audit` for signature
 * failures and `422` for schema failures.
 *
 * The HMAC compare always uses `crypto.timingSafeEqual` — the legacy
 * JS client did the same thing for a reason: plain `===` leaks
 * byte-position info over repeated calls.
 *
 * A `Clock` function is injectable so tests can pin `now()` to a
 * deterministic value; production uses `() => Date.now()`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from './canonical';
import type { DiditConfig } from './config';
import { DiditError } from './errors';
import { type WebhookBody, WebhookBodySchema } from './schemas';

/* ---------- Types ---------- */

/**
 * Minimal clock abstraction. Returns the current time in Unix
 * milliseconds. Injectable so tests can pin it without stubbing
 * globals.
 */
export type Clock = () => number;

/**
 * The shape callers hand to `verifyWebhook`: raw JSON body (parsed)
 * and the relevant headers, normalized to lowercase keys. The route
 * handler in `apps/web/src/app/api/webhooks/didit/route.ts` is
 * responsible for pulling these out of the Request object.
 */
export interface WebhookVerificationInput {
  /**
   * Already JSON-parsed body. Parsing (not validation) must happen
   * before calling `verifyWebhook` because the HMAC is computed over
   * the raw JSON *value*, not the wire bytes — any intermediate
   * proxy can re-serialize without breaking V2 as long as the
   * value tree is unchanged.
   */
  readonly body: unknown;
  /** Lowercased header map. Keys: `x-signature-v2`, `x-signature-simple`, `x-timestamp`. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Result of a successful verification. The validated, branded
 * `WebhookBody` is included so the route handler does not re-parse
 * the body after verification passes.
 */
export interface WebhookVerificationResult {
  readonly body: WebhookBody;
  /** Which signature scheme was accepted. Recorded in the audit log. */
  readonly scheme: 'v2' | 'simple';
  /** Raw Unix seconds from `X-Timestamp`, after freshness validation. */
  readonly timestamp: number;
}

/* ---------- Header extraction ---------- */

/**
 * Pull a lowercased header value, trimmed. Returns `undefined` for
 * missing or empty headers so the caller can short-circuit on a
 * single truthiness check.
 */
function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse the `X-Timestamp` header into Unix seconds. Throws
 * `DiditError('missing_timestamp', …)` when absent, and
 * `DiditError('invalid_signature', …)` when present but not a
 * base-10 integer — a malformed timestamp is indistinguishable from
 * a deliberately crafted bypass attempt.
 */
function parseTimestampHeader(headers: Readonly<Record<string, string | undefined>>): number {
  const raw = readHeader(headers, 'x-timestamp');
  if (raw === undefined) {
    throw new DiditError('missing_timestamp', 'Didit webhook is missing the X-Timestamp header.');
  }
  if (!/^\d{1,15}$/.test(raw)) {
    throw new DiditError(
      'invalid_signature',
      `Didit webhook X-Timestamp is not an integer: ${raw}`,
    );
  }
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new DiditError('invalid_signature', `Didit webhook X-Timestamp is out of range: ${raw}`);
  }
  return seconds;
}

/**
 * Validate the timestamp freshness. Throws
 * `DiditError('stale_signature', …)` when the delta between now and
 * the header exceeds `webhookDriftSeconds`. The drift window is
 * symmetric — a webhook timestamped slightly in the future is
 * still accepted to tolerate clock skew on the Didit side.
 */
function assertTimestampFresh(config: DiditConfig, incomingSeconds: number, clock: Clock): void {
  const nowSeconds = Math.floor(clock() / 1_000);
  const delta = Math.abs(nowSeconds - incomingSeconds);
  if (delta > config.webhookDriftSeconds) {
    throw new DiditError(
      'stale_signature',
      `Didit webhook timestamp is outside the ${config.webhookDriftSeconds}s drift window (delta=${delta}s).`,
      { context: { delta, window: config.webhookDriftSeconds } },
    );
  }
}

/**
 * Cross-check `body.timestamp` (inside the HMAC-signed blob) with
 * the `X-Timestamp` request header (outside the signature). Mismatch
 * throws `DiditError('timestamp_mismatch')` — see the AUD-INT-REPLAY-001
 * fix in `verifyWebhook` for the full rationale.
 *
 * Tolerates two body.timestamp formats Didit has used in the wild:
 *   * integer-string unix seconds (`"1712345678"`)
 *   * ISO-8601 (`"2026-04-24T10:30:00Z"`)
 *
 * A 1-second tolerance absorbs millisecond-rounding drift between
 * producer + consumer; anything larger is either a format we do not
 * recognise (parser returns `null`, we skip) or a forged replay
 * (reject). `body.timestamp` is optional per Didit's schema; when
 * absent we skip the check so deliveries that historically omit it
 * stay accepted.
 */
// Strict ISO-8601 shape check — dd-MM-ddTHH:MM:SS(.fff)(Z|±HH:MM).
// Restricting the parseable surface keeps arbitrary short strings
// (`"ts-string-1"`) from being accepted by `Date.parse` on runtimes
// that are permissive about leading tokens. Only formats that Didit
// has actually used on the wire reach the numeric comparison.
const ISO_8601_SHAPE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function assertBodyTimestampMatchesHeader(body: unknown, headerSeconds: number): void {
  if (body === null || typeof body !== 'object') return;
  const raw = (body as Record<string, unknown>)['timestamp'];

  let bodySeconds: number | null = null;
  // Per official Didit docs (`26_webhooks.md` example payload), the
  // canonical wire form for `timestamp` is a Unix-seconds INTEGER
  // (e.g. `1774970000`). String forms are accepted for backward
  // compatibility with older fixtures (numeric-string or ISO-8601).
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    bodySeconds = raw;
  } else if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d{1,15}$/.test(raw)) {
      const n = Number.parseInt(raw, 10);
      bodySeconds = Number.isSafeInteger(n) ? n : null;
    } else if (ISO_8601_SHAPE.test(raw)) {
      const parsed = Date.parse(raw);
      bodySeconds = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
  } else {
    return; // not a string or number → skip silently
  }

  // Unrecognised format: skip — signalling `timestamp_mismatch` for
  // every unknown encoding would brittlely reject legit webhooks if
  // Didit ever ships a new format.
  if (bodySeconds === null) return;

  if (Math.abs(bodySeconds - headerSeconds) > 1) {
    throw new DiditError(
      'timestamp_mismatch',
      `Didit webhook body.timestamp (${raw}) does not match X-Timestamp (${headerSeconds}).`,
      { context: { bodySeconds, headerSeconds, delta: Math.abs(bodySeconds - headerSeconds) } },
    );
  }
}

/* ---------- HMAC helpers ---------- */

/**
 * Compute the hex HMAC-SHA256 of `payload` under `secret`. Wraps
 * `node:crypto` so the rest of the module can stay pure TypeScript.
 */
function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Constant-time equality for two hex strings of equal length.
 * Returns `false` on length mismatch so the `timingSafeEqual` call
 * can never throw. The hex shapes are always 64 chars (SHA-256
 * hex), but we do not hard-code that — the check is length-agnostic
 * so a future algorithm swap only needs `hmacHex` updated.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify the `X-Signature-V2` HMAC. Returns `true` when the computed
 * HMAC over `canonicalJson(body)` matches the header. The caller
 * decides the error semantics — this helper is a pure predicate so
 * the V2 + Simple fallback branching stays readable.
 */
function verifyV2Signature(config: DiditConfig, body: unknown, signatureV2: string): boolean {
  let canonical: string;
  try {
    canonical = canonicalJson(body);
  } catch (err) {
    throw new DiditError(
      'invalid_webhook_body',
      'Failed to canonicalize Didit webhook body for HMAC computation.',
      { cause: err },
    );
  }
  const expected = hmacHex(config.webhookSecret, canonical);
  return constantTimeHexEqual(expected, signatureV2);
}

/**
 * Build the Simple-signature payload from the fields Didit uses.
 * Missing fields are coerced to empty strings to match the legacy
 * server behavior — the HMAC will simply fail to match if the
 * caller's body does not carry these fields, which is the correct
 * outcome.
 */
function buildSimplePayload(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    return ':::';
  }
  const record = body as Record<string, unknown>;
  // Per `26_webhooks.md` example payload + reference verifier:
  //   `${timestamp}:${session_id}:${status}:${webhook_type}`
  // Didit's reference impl uses `jsonBody.timestamp || ""` and JSON
  // numbers stringify naturally there. Match that: stringify numbers,
  // pass strings through, blank everything else. Anything else here
  // produces an HMAC the wire signature can never match.
  const tsRaw = record['timestamp'];
  const timestamp =
    typeof tsRaw === 'string'
      ? tsRaw
      : typeof tsRaw === 'number' && Number.isFinite(tsRaw)
        ? String(tsRaw)
        : '';
  const sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : '';
  const status = typeof record['status'] === 'string' ? record['status'] : '';
  const webhookType = typeof record['webhook_type'] === 'string' ? record['webhook_type'] : '';
  return `${timestamp}:${sessionId}:${status}:${webhookType}`;
}

/**
 * Verify the `X-Signature-Simple` HMAC. Returns `true` when the
 * computed HMAC over the four-field colon-join matches the header.
 */
function verifySimpleSignature(
  config: DiditConfig,
  body: unknown,
  signatureSimple: string,
): boolean {
  const payload = buildSimplePayload(body);
  const expected = hmacHex(config.webhookSecret, payload);
  return constantTimeHexEqual(expected, signatureSimple);
}

/* ---------- Body parsing ---------- */

/**
 * Validate a (presumed) webhook body against `WebhookBodySchema`.
 * Throws `DiditError('invalid_webhook_body', …)` on shape drift —
 * the route handler maps that to 422 + audit.
 *
 * Exposed so the worker can reuse it on a body retrieved from the
 * Didit API (e.g. reconcile path) without going through the HMAC
 * gate again.
 */
export function parseWebhookBody(body: unknown): WebhookBody {
  const parsed = WebhookBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new DiditError(
      'invalid_webhook_body',
      `Didit webhook body failed schema validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      {
        cause: parsed.error,
        context: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  return parsed.data;
}

/* ---------- Public entry point ---------- */

/**
 * Verify a single Didit webhook delivery. On success, returns the
 * validated body + the scheme that was accepted + the timestamp.
 * On failure, throws a `DiditError` with one of:
 *
 *   * `missing_timestamp` — X-Timestamp absent
 *   * `missing_signature` — neither V2 nor Simple header present
 *   * `stale_signature`  — timestamp outside the drift window
 *   * `invalid_signature` — header present but HMAC did not match
 *   * `invalid_webhook_body` — body did not pass Zod validation
 *
 * Order matters: timestamp → freshness → signature → body schema.
 * This order lets the route handler log the most actionable failure
 * (a stale webhook is a deployment problem, an invalid signature is
 * a security event, a schema failure is an upstream change).
 */
export function verifyWebhook(
  config: DiditConfig,
  input: WebhookVerificationInput,
  clock: Clock = () => Date.now(),
): WebhookVerificationResult {
  const timestampSeconds = parseTimestampHeader(input.headers);
  assertTimestampFresh(config, timestampSeconds, clock);

  // AUD-INT-REPLAY-001 fix: X-Timestamp header is NOT part of the
  // HMAC payload — signature covers `canonicalJson(body)` only. A
  // captured `(body, X-Signature-V2, X-Timestamp)` tuple could be
  // replayed with a forged fresh X-Timestamp: the signature still
  // matches (body unchanged) and the freshness window passes.
  // `body.timestamp` IS inside the signed blob, so if Didit
  // populates it we cross-check against the header: a mismatch is
  // an unambiguous replay-forge signal. Didit's schema marks the
  // field optional so we skip silently when it is absent; in that
  // case the other guards (freshness window + downstream idempotency
  // on session_id) stay in place.
  assertBodyTimestampMatchesHeader(input.body, timestampSeconds);

  const signatureV2 = readHeader(input.headers, 'x-signature-v2');
  const signatureSimple = readHeader(input.headers, 'x-signature-simple');

  if (signatureV2 === undefined && signatureSimple === undefined) {
    throw new DiditError(
      'missing_signature',
      'Didit webhook must carry X-Signature-V2 or X-Signature-Simple.',
    );
  }

  let accepted: 'v2' | 'simple' | null = null;

  if (signatureV2 !== undefined && verifyV2Signature(config, input.body, signatureV2)) {
    accepted = 'v2';
  } else if (
    signatureSimple !== undefined &&
    verifySimpleSignature(config, input.body, signatureSimple)
  ) {
    accepted = 'simple';
  }

  if (accepted === null) {
    throw new DiditError(
      'invalid_signature',
      'Didit webhook HMAC did not match the configured secret.',
      {
        context: {
          schemePresent: {
            v2: signatureV2 !== undefined,
            simple: signatureSimple !== undefined,
          },
        },
      },
    );
  }

  const body = parseWebhookBody(input.body);
  return Object.freeze({
    body,
    scheme: accepted,
    timestamp: timestampSeconds,
  });
}
