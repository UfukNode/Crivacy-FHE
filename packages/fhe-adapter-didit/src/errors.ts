/**
 * Error taxonomy for the Didit KYC provider client.
 *
 * Every helper in `@crivacy-fhe/adapter-didit` throws `DiditError` (and only
 * `DiditError`) when it fails. Keeping a single error class with a
 * narrow `.code` union lets route handlers + the verification worker
 * branch on failure class without string-matching the message:
 *
 *   * Session-create + decision-fetch errors map to public
 *     `verification_provider_unavailable` / `verification_failed`
 *     API responses.
 *   * Webhook signature failures never produce a body — the handler
 *     responds 401 and writes a tamper-evident audit log.
 *   * Mapping errors (missing / unknown / out-of-range fields in the
 *     Didit decision) surface as `invalid_proof_input` so the
 *     verification worker can quarantine the decision for manual
 *     review instead of crashing the job.
 *
 * The code union is intentionally narrow and concrete. Each code maps
 * to exactly one failure mode. Adding a new code is a documented
 * surface change: test suites assert specific branches, and the
 * verification worker in `apps/web/src/server/jobs/verification/**`
 * branches on `error.code` to pick the right retry + alert behavior.
 *
 * `unexpected` is reserved for programmer errors — a bug we did not
 * anticipate. Network, timeout, response-shape, and upstream-side
 * failures all get semantically meaningful codes.
 */

export type DiditErrorCode =
  /* Config + bootstrap */
  | 'invalid_config' // env failed Zod validation (missing api key, bad URL)
  /* Request validation (pre-flight) */
  | 'invalid_session_id' // session id empty or malformed
  | 'invalid_workflow_id' // workflow id does not match either configured workflow
  | 'invalid_vendor_data' // vendor_data (our internal user ref) empty or too long
  | 'invalid_callback_url' // callback URL not a valid http(s) URL
  | 'invalid_full_name' // Didit User entity full_name missing/empty/single-token (Sprint 8 name anchor)
  /* Webhook signature path */
  | 'missing_signature' // neither X-Signature-V2 nor X-Signature-Simple present
  | 'missing_timestamp' // X-Timestamp header absent when verifying
  | 'stale_signature' // timestamp outside the 5-minute drift window
  | 'invalid_signature' // HMAC comparison failed (tampered body / wrong secret)
  | 'timestamp_mismatch' // body.timestamp doesn't match X-Timestamp header — replay-forge signal
  | 'invalid_webhook_body' // webhook body failed Zod schema validation
  /* HTTP transport */
  | 'request_timeout' // AbortController timeout fired
  | 'network_error' // fetch threw (DNS, TCP, TLS)
  | 'http_error' // non-2xx outside the structured-error family
  | 'unauthorized' // 401 — Didit rejected our api key
  | 'forbidden' // 403 — Didit refused the request
  | 'not_found' // 404 — session or workflow unknown to Didit
  | 'rate_limited' // 429 — upstream throttle
  | 'service_unavailable' // 5xx during any Didit call
  /* Response validation */
  | 'invalid_response' // body failed Zod validation (shape drift)
  | 'empty_response' // upstream returned 200 but body was empty
  /* Verification semantics */
  | 'session_expired' // getDecision: Didit reports session expired
  | 'session_declined' // getDecision: Didit reports session declined (when caller expected approval)
  | 'decision_pending' // decision requested before upstream produced a final state
  | 'unknown_status' // status string we do not recognize
  | 'unknown_workflow' // webhook references a workflow id we did not configure
  | 'invalid_proof_input' // decision missing fields required to compute proofHash
  /* Programmer errors */
  | 'unexpected'; // we never promote a driver error silently to this code

/**
 * Didit module error. Subclasses `Error` with a stable `name` so
 * callers can narrow by `err.name === 'DiditError'` and still receive
 * the strong code / cause chain.
 *
 * `cause` is standard ES2022 — we pass the original `fetch`/Zod/
 * upstream error through for the observability pipeline. `context`
 * is a free shape keyed to the failing call site so the `pino` child
 * logger can attach it to the error log line (e.g. the session id,
 * the workflow tag, the HTTP status). PII MUST NOT be placed on
 * `context` — Didit decisions contain identity documents and the
 * audit redaction layer never sees error context.
 */
export class DiditError extends Error {
  override readonly name = 'DiditError';
  readonly code: DiditErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: DiditErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      // ES2022: Error.cause
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (options?.context !== undefined) {
      this.context = options.context;
    }
    // Make the error appear correctly under V8 stack traces even when
    // subclassed across modules (Node transpilation quirks).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Wrap an unknown driver/runtime error into a `DiditError` with
   * the given code, preserving the original error as `cause`. If the
   * input is already a `DiditError`, it is returned unchanged so the
   * first helper in the call chain wins (no double-wrapping).
   */
  static wrap(
    code: DiditErrorCode,
    message: string,
    cause: unknown,
    context?: Readonly<Record<string, unknown>>,
  ): DiditError {
    if (cause instanceof DiditError) {
      return cause;
    }
    return new DiditError(code, message, { cause, ...(context ? { context } : {}) });
  }
}

/**
 * Type guard used by the route-layer error mapper. Keeping this in
 * the same module as `DiditError` means a single import covers both.
 */
export function isDiditError(value: unknown): value is DiditError {
  return value instanceof DiditError;
}

/**
 * Narrow by one of a fixed set of codes. Used in tests and in route
 * handlers that only care about e.g. `invalid_signature` vs the rest.
 */
export function isDiditErrorWithCode<C extends DiditErrorCode>(
  value: unknown,
  ...codes: readonly C[]
): value is DiditError & { code: C } {
  return value instanceof DiditError && (codes as readonly string[]).includes(value.code);
}
